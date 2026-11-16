'use strict';

// The shared mechanics of the team server's bounded, append-only JSON logs:
// the membership audit (`audit-log.js`), the project audit
// (`project-audit.js`) and the pool usage log (`usage-log.js`). Each owner
// keeps its own entry schema, kinds, failure reasons and log event names;
// this module holds what they have in common.
//
// Document shape: `{ schema_version, floor_seq, next_seq, entries }`. Entries
// carry a strictly increasing `seq`. `floor_seq` is the lowest sequence number
// that may still be present: every entry with a smaller seq was dropped to stay
// inside the bounds. It starts at 1 and only moves forward.
//
// Strict load: refused content (a file the owner's `parse` refuses, one over
// the read cap, one the safe-file rules refuse for what it is) marks the log
// broken for the life of the object. A broken file is never rewritten and
// never emptied. A passing read failure (a file held by a scanner or a backup,
// no free descriptor, a file that changed while it was read) answers
// unavailable for that call and writes nothing; the next call loads again.
// Anything not classified as passing is refused content (fail closed).
//
// A write is held in memory only after it is durable. A write that throws may
// still have landed (the rename done, the directory sync failed), so the held
// document is dropped and the next call re-reads the file: a seq is never
// reused for an entry that is already on disk.
//
// Set aside: a refusal is classed (`refusal()`). Only a file refused for its
// content (not JSON, refused by `parse`, over the read cap) may be renamed
// aside, inside its own directory, by its owner at start; a newer schema (a
// safe integer above the empty document's), a path the guard refuses and an
// operating-system refusal stay broken. The file just set aside and the newest
// SET_ASIDE_KEEP - 1 others stay; older ones go.

const fs = require('node:fs');
const path = require('node:path');

const {
  readJson: durableReadJson, writeJson: durableWriteJson, renameDurable,
} = require('../../services/host/durable-json');
const { hasExactKeys, isPlainObject } = require('./member-schema');
const { safeLogger } = require('./safe-logger');

const LOG_DOCUMENT_KEYS = Object.freeze(['schema_version', 'floor_seq', 'next_seq', 'entries']);

// Operating-system errors on open, stat or read that a moment's wait can clear.
// Any other code (ELOOP, EISDIR, ENOTDIR, an unknown one) is refused content.
const PASSING_READ_CODES = Object.freeze(new Set([
  'EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EIO', 'EAGAIN', 'EWOULDBLOCK', 'EINTR', 'ENOMEM',
]));
// durable-json's refusal of a file whose size or times moved during the read.
const CHANGED_DURING_READ = 'metadata_changed_during_read';
// durable-json's refusal of a file that is not one regular file inside the cap.
const INVALID_FILE = 'invalid_metadata_file';
const SET_ASIDE_KEEP = 3;
const SET_ASIDE_MARK = '.unreadable-';
// The digits of an ISO time: YYYYMMDDHHMMSSmmm. A name of another width is not ours.
const KEPT_STAMP = /^[0-9]{17}$/u;

// The UTC stamp of a kept or trashed name: `new Date(ms).toISOString()` with everything but the
// digits dropped (YYYYMMDDHHMMSSmmm), or null for a time that gives no such stamp.
function utcStamp(ms) {
  try {
    const stamp = new Date(ms).toISOString().replace(/[^0-9]/gu, '');
    return KEPT_STAMP.test(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

function isPassingReadError(error) {
  if (!(error instanceof Error)) return false;
  if (typeof error.code === 'string') return PASSING_READ_CODES.has(error.code);
  return error.code === undefined && error.message === CHANGED_DURING_READ;
}

// The two state-change events derive from the owner's rejected event name
// (`team_audit.rejected` gives `team_audit.read_failed`), so every owner logs
// them without a new constructor field.
function readEvents(rejected) {
  const prefix = rejected.endsWith('.rejected') ? rejected.slice(0, -'.rejected'.length) : rejected;
  return {
    failed: `${prefix}.read_failed`,
    recovered: `${prefix}.read_recovered`,
    setAside: `${prefix}.set_aside`,
    setAsideFailed: `${prefix}.set_aside_failed`,
  };
}

// How a read that threw was refused: content (not JSON, a root that is not an
// object, one regular file over the cap) or the operating system (a link, a
// directory, a hard-linked file, any code that is not a passing one).
function readRefusal(error, filePath, readCapBytes) {
  if (error instanceof SyntaxError || error?.message === 'invalid_metadata_root') return 'content';
  if (error?.code === undefined && error?.message === INVALID_FILE) {
    try {
      const stat = fs.lstatSync(filePath);
      return stat.isFile() && stat.nlink === 1 && stat.size > readCapBytes ? 'content' : 'os';
    } catch {
      return 'os';
    }
  }
  return 'os';
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : null;
}

// True when a rename that threw had moved the file: its own path is gone and
// the kept name is a regular file (a directory sync that failed after it).
function renameLanded(fromPath, toPath) {
  try {
    fs.lstatSync(fromPath);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  try {
    return fs.lstatSync(toPath).isFile();
  } catch {
    return false;
  }
}

function emptyLogDocument(schemaVersion) {
  return { schema_version: schemaVersion, floor_seq: 1, next_seq: 1, entries: [] };
}

// The document shape and the sequence rules: at most `maxEntries` entries, each
// accepted by `validEntry`, with seqs strictly increasing from `floor_seq` and
// below `next_seq`.
function validLogDocument(doc, { schemaVersion, maxEntries, validEntry }) {
  if (!isPlainObject(doc) || doc.schema_version !== schemaVersion || !hasExactKeys(doc, LOG_DOCUMENT_KEYS)) return false;
  if (!Number.isSafeInteger(doc.floor_seq) || doc.floor_seq < 1 || !Number.isSafeInteger(doc.next_seq)
    || doc.next_seq < doc.floor_seq || !Array.isArray(doc.entries) || doc.entries.length > maxEntries) {
    return false;
  }
  let previous = doc.floor_seq - 1;
  for (const entry of doc.entries) {
    if (!validEntry(entry) || entry.seq <= previous) return false;
    previous = entry.seq;
  }
  return previous < doc.next_seq;
}

// Drops the oldest entries until the document fits both bounds, and records the
// new floor. The newest entry is always kept. Returns the candidate itself when
// it already fits.
function boundLogDocument(candidate, { maxEntries, maxBytes }) {
  const sizes = candidate.entries.map((entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1);
  let size = Buffer.byteLength(JSON.stringify({ ...candidate, entries: [] }), 'utf8')
    + sizes.reduce((sum, value) => sum + value, 0);
  let drop = 0;
  while (drop < candidate.entries.length - 1
    && (candidate.entries.length - drop > maxEntries || size > maxBytes)) {
    size -= sizes[drop];
    drop += 1;
  }
  if (drop === 0) return candidate;
  const entries = candidate.entries.slice(drop);
  return { ...candidate, entries, floor_seq: entries[0].seq };
}

class BoundedLogFile {
  // `parse(stored)` returns the document to hold, or null to refuse the file.
  // `events` names the owner's two log events. Only an error code is logged.
  constructor({
    filePath, readCapBytes, parse, emptyDocument, events, logger = null, assertSafePath = null,
    readJson = durableReadJson, writeJson = durableWriteJson, renameFile = renameDurable,
  } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('BoundedLogFile requires a filePath.');
    if (!Number.isSafeInteger(readCapBytes) || readCapBytes < 1) throw new TypeError('BoundedLogFile requires a read cap.');
    if (typeof parse !== 'function' || typeof emptyDocument !== 'function') {
      throw new TypeError('BoundedLogFile requires parse and emptyDocument.');
    }
    if (!isPlainObject(events) || typeof events.rejected !== 'string' || typeof events.writeFailed !== 'string') {
      throw new TypeError('BoundedLogFile requires its log event names.');
    }
    this.filePath = filePath;
    this._readCapBytes = readCapBytes;
    this._parse = parse;
    this._emptyDocument = emptyDocument;
    this._events = events;
    this._readEvents = readEvents(events.rejected);
    this._log = safeLogger(logger);
    this._assertSafePath = typeof assertSafePath === 'function' ? assertSafePath : null;
    this._readJson = readJson;
    this._writeJson = writeJson;
    this._renameFile = renameFile;
    this._doc = null;
    // Why the log is broken ('content', 'newer_schema', 'unsafe_path' or 'os');
    // null while it is not.
    this._refusal = null;
    // The held document stands for a missing file and nothing was written yet.
    this._absent = false;
    // The last load met a passing failure; logged once per failing stretch.
    this._readFailing = false;
  }

  // The held document, loading it when none is held; null when the log is
  // broken or this load met a passing read failure.
  load() {
    if (this._refusal !== null) return null;
    if (this._doc) return this._doc;
    try {
      if (this._assertSafePath) this._assertSafePath(this.filePath);
    } catch (error) {
      return this._refuse(error, 'unsafe_path');
    }
    let stored;
    try {
      stored = this._readJson(this.filePath, { maxBytes: this._readCapBytes });
    } catch (error) {
      if (isPassingReadError(error)) return this._readFailed(error);
      return this._refuse(error, readRefusal(error, this.filePath, this._readCapBytes));
    }
    let doc;
    try {
      doc = stored === null ? this._emptyDocument() : this._parse(stored);
    } catch (error) {
      return this._refuse(error, this._contentRefusal(stored));
    }
    if (!doc) return this._refuse(null, this._contentRefusal(stored));
    this._absent = stored === null;
    if (this._readFailing) {
      this._readFailing = false;
      this._log('INFO', this._readEvents.recovered, {});
    }
    this._doc = doc;
    return this._doc;
  }

  // True while the last load met a passing read failure and the log is not
  // broken: its null means "not now", not "refused".
  readFailing() {
    return this._readFailing && this._refusal === null;
  }

  _readFailed(error) {
    if (!this._readFailing) {
      this._readFailing = true;
      this._log('WARN', this._readEvents.failed, { code: error.code || CHANGED_DURING_READ });
    }
    return null;
  }

  // A stored safe integer above the schema the owner writes is a newer Jenny's
  // file, never set aside.
  _contentRefusal(stored) {
    const version = isPlainObject(stored) ? stored.schema_version : undefined;
    return Number.isSafeInteger(version) && version > this._emptyDocument().schema_version ? 'newer_schema' : 'content';
  }

  _refuse(error, refusal) {
    this._refusal = refusal;
    this._log('ERROR', this._events.rejected, { code: errorCode(error), cause: refusal });
    return null;
  }

  // Why the log is broken (null when it is not).
  refusal() {
    return this._refusal;
  }

  // True while the held document stands for a missing file.
  wasAbsent() {
    return Boolean(this._doc) && this._absent;
  }

  // Renames a file refused for its content to `<name>.unreadable-<UTC digits>`
  // in its own directory (the guard checks both names; the rename is durable and
  // never replaces a file), prunes older kept files, and holds an empty document
  // so the owner can start a fresh log. A rename that threw after the file moved
  // counts as moved. Answers { ok: true, keptName }, or { ok: false, passing }
  // with everything as it was: `passing` when the refusal may clear in a moment.
  setAside({ now }) {
    if (this._refusal !== 'content') return { ok: false, passing: false };
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}${SET_ASIDE_MARK}`;
    let keptName = null;
    let target = null;
    let syncFailed = false;
    try {
      const stamp = utcStamp(now);
      if (stamp === null) throw new Error('set_aside_bad_clock');
      keptName = `${prefix}${stamp}`;
      target = path.join(directory, keptName);
      if (this._assertSafePath) {
        this._assertSafePath(this.filePath);
        this._assertSafePath(target);
      }
      this._renameFile(this.filePath, target);
    } catch (error) {
      if (target === null || !renameLanded(this.filePath, target)) {
        this._log('ERROR', this._readEvents.setAsideFailed, { code: errorCode(error) });
        return { ok: false, passing: PASSING_READ_CODES.has(errorCode(error)) };
      }
      syncFailed = true;
    }
    const kept = this._pruneSetAside(directory, prefix, keptName);
    this._refusal = null;
    this._doc = this._emptyDocument();
    this._absent = false;
    this._log('ERROR', this._readEvents.setAside, syncFailed ? { kept, directory_sync_failed: true } : { kept });
    return { ok: true, keptName };
  }

  // Deletes kept files beyond the newest SET_ASIDE_KEEP - 1 others (the
  // fixed-width digits sort by time); the file just set aside is never a
  // candidate. Only regular files of exactly that name shape that pass the path
  // guard go. Answers how many stay, or null when the directory cannot be listed.
  _pruneSetAside(directory, prefix, keptName) {
    let others;
    try {
      others = fs.readdirSync(directory)
        .filter((name) => name !== keptName && name.startsWith(prefix) && KEPT_STAMP.test(name.slice(prefix.length)))
        .sort();
    } catch {
      return null;
    }
    let kept = others.length + 1;
    for (const name of others.slice(0, Math.max(0, others.length - (SET_ASIDE_KEEP - 1)))) {
      try {
        const file = path.join(directory, name);
        if (this._assertSafePath) this._assertSafePath(file);
        if (fs.lstatSync(file).isFile()) {
          fs.rmSync(file);
          kept -= 1;
        }
      } catch {
        // A file that cannot go, or that the guard refuses, stays and is counted.
      }
    }
    return kept;
  }

  // Writes the candidate durably and holds it. Answers false when the log is
  // broken or holds no document (a candidate follows a successful load), and
  // when the write fails; a failed write drops the held document, since it
  // may have landed, so the next call re-reads the file.
  persist(candidate) {
    if (this._refusal !== null || !this._doc) return false;
    try {
      if (this._assertSafePath) this._assertSafePath(this.filePath);
      this._writeJson(this.filePath, candidate);
    } catch (error) {
      this._doc = null;
      this._log('ERROR', this._events.writeFailed, { code: error?.code || null });
      return false;
    }
    this._doc = candidate;
    this._absent = false;
    return true;
  }
}

module.exports = {
  LOG_DOCUMENT_KEYS, BoundedLogFile, boundLogDocument, emptyLogDocument, isPassingReadError, utcStamp,
  validLogDocument,
};
