'use strict';

const fs = require('fs');
const path = require('path');

const { FileJsonStore } = require('./file-json-store');
const { safeEmitLog } = require('./session-store-logging');

// Durable superset of the chats that MAY hold an active turn on disk, so the
// startup active-turn seed (getActiveTurnSnapshots -> managed-sidecar
// reconciliation) reads those chats instead of every chat file.
//
//   <sessions>/_active_turns.state = { version: 1, schema_version, session_ids: [...] }
//
// Invariant: while the file is trusted, every chat whose file on disk can carry
// a non-null active_turn is listed. A chat is added (atomic, fsynced write)
// BEFORE the write that sets its active turn, and is only dropped by a rebuild
// computed from verified state: the seed's reads plus every chat with a pending
// write. A chat whose read failed stays listed. When the file is missing,
// unreadable, of another version or schema, or the store is migrating, the
// seed reads every chat once (today's behaviour) and the rebuild writes a fresh
// file. A failed write removes the file, which forces that full read next start.
//
// A separate file, not an index field: the index summary is the renderer
// projection (see session-summary-projection.js), and the name does not end in
// `.json`, so index recovery and migration never treat it as a chat file. No
// store schema bump: an older build ignores the file.
const MARKER_FILE_NAME = '_active_turns.state';
const MARKER_VERSION = 1;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameIds(left, right) {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

class ActiveTurnMarker {
  constructor(backend, { enabled = false } = {}) {
    this._backend = backend;
    // disabled | unloaded | trusted | untrusted
    this._state = enabled ? 'unloaded' : 'disabled';
    this._ids = new Set();
    this._retained = new Set();
    this._writer = null;
  }

  get filePath() {
    return path.join(this._backend._rootDir, MARKER_FILE_NAME);
  }

  // The chats the startup seed must read, or null for every chat.
  seedCandidates() {
    this._load();
    return this._state === 'trusted' ? [...this._ids] : null;
  }

  // The store state is not one the file describes (index rebuilt from the chat
  // files): read every chat once this run. The file goes too: note() skips an
  // untrusted marker, so a crash before the seed's rebuild must not leave a
  // valid-looking file that misses a turn set in between.
  distrust() {
    if (this._state === 'disabled') return;
    this._state = 'untrusted';
    try {
      fs.unlinkSync(this.filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') this._log('ERROR', 'active_turn_marker_remove_failed', error);
    }
  }

  // Called before a write that can put a non-null active_turn on disk.
  note(sessionId, activeTurn) {
    if (this._state === 'disabled' || !isPlainObject(activeTurn)) return;
    this._load();
    if (this._state !== 'trusted' || this._ids.has(sessionId) || !this._writable()) return;
    this._ids.add(sessionId);
    this._persist();
  }

  // Rewrites the file from verified state. Only sound once the seed ran: before
  // that the registry does not know what an unread chat holds on disk.
  rebuild({ retained = null } = {}) {
    if (this._state === 'disabled' || !this._writable() || !this._backend._activeTurnScanSeeded) return;
    const backend = this._backend;
    if (retained) for (const id of retained) this._retained.add(id);
    const ids = new Set();
    for (const [id, activeTurn] of backend._scanActiveTurns) {
      if (activeTurn && backend.hasSession(id)) ids.add(id);
    }
    // A pending write may still have to clear an active turn the file holds.
    for (const id of new Set([...backend._dirtySessionIds, ...backend._sessionStores.keys()])) {
      if (backend.hasSession(id) && backend.hasPendingWriteForSession(id)) ids.add(id);
    }
    for (const id of this._retained) {
      if (backend.hasSession(id) && !backend._scanActiveTurns.get(id)) ids.add(id);
      if (!backend.hasSession(id)) this._retained.delete(id);
    }
    if (this._state === 'trusted' && sameIds(ids, this._ids)) return;
    this._ids = ids;
    this._persist();
  }

  _writable() {
    const backend = this._backend;
    return backend._mode === 'split' && backend._newerSchemaVersion === 0 && !backend._pendingSplitMigration;
  }

  _load() {
    if (this._state !== 'unloaded') return;
    this._state = 'untrusted';
    if (!this._writable()) return;
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this._log('WARN', 'active_turn_marker_unreadable', error);
      return;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      this._log('WARN', 'active_turn_marker_unreadable', error);
      return;
    }
    if (
      !isPlainObject(value)
      || value.version !== MARKER_VERSION
      || value.schema_version !== this._backend._schemaVersion
      || !Array.isArray(value.session_ids)
      || !value.session_ids.every((id) => typeof id === 'string')
    ) {
      this._log('WARN', 'active_turn_marker_unknown', null);
      return;
    }
    this._ids = new Set(value.session_ids);
    this._state = 'trusted';
  }

  _persist() {
    try {
      if (!this._writer) this._writer = new FileJsonStore(this.filePath, { compact: true, logger: this._backend._logger });
      this._writer.writeImmediate({
        version: MARKER_VERSION,
        schema_version: this._backend._schemaVersion,
        session_ids: [...this._ids].sort(),
      });
      this._state = 'trusted';
    } catch (error) {
      // The file on disk no longer covers every chat: without it, the next
      // start reads every chat.
      this._state = 'untrusted';
      this._log('WARN', 'active_turn_marker_write_failed', error);
      try {
        fs.unlinkSync(this.filePath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') this._log('ERROR', 'active_turn_marker_remove_failed', unlinkError);
      }
    }
  }

  _log(level, event, error) {
    safeEmitLog(this._backend._logger, level, `${this._backend._storeName}.${event}`, {
      filePath: this.filePath,
      errorCode: error?.code || null,
      errorMessage: error ? String(error.message || error) : null,
    });
  }
}

module.exports = { ActiveTurnMarker, MARKER_FILE_NAME, MARKER_VERSION };
