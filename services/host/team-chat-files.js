'use strict';

// The team chat store's guarded file access and failure kinds (row 123,
// split out of team-chat-channel.js in slice 2a-3b). Every path passes the
// guard before it is read, listed, created, written or removed. A refusal is
// answered as is; corruption carries a fixed cause token (never file text);
// a transient I/O error never latches the store or breaks a channel.

const fs = require('node:fs');
const path = require('node:path');

const { hostFailure } = require('../../server/api-contract');

// A name that never exists: guarding it checks only its directory.
const GUARD_PROBE = '.guard-probe';

// A refusal: answered as is and never latches the store.
function refuse(kind, reason) {
  throw Object.assign(new Error(reason), { refusal: hostFailure(kind, reason) });
}

// Corruption: the schema reason for an unknown version, store_failed otherwise.
function corrupt(cause, schemaRefusal = false) {
  return Object.assign(new Error(cause), {
    cause, brokenReason: schemaRefusal ? 'team_chat_schema_unsupported' : 'team_chat_store_failed',
  });
}

const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EIO', 'EAGAIN']);
// An I/O error worth retrying: it never latches the store or breaks a channel.
const isTransient = (error) => TRANSIENT_CODES.has(error?.code) || error?.message === 'metadata_changed_during_read';

// A read that failed for any other reason is corruption; the cause is a fixed
// token (a parse error message can quote file content).
function readFailure(error) {
  if (isTransient(error) || error?.brokenReason) return error;
  const token = error instanceof SyntaxError ? 'json_invalid'
    : /^[a-z_]{1,64}$/u.test(error?.message || '') ? error.message : 'read_failed';
  return Object.assign(corrupt(token), { code: error?.code || null });
}

function checked(result) {
  if (!result.ok) throw corrupt(result.reason, result.schema);
}

// The store's file access. A missing parent directory reads as absent;
// `written` counts the files the current operation has written.
function createFileIo({ guard, ops, log }) {
  const guardDirectory = (dir) => guard(path.join(dir, GUARD_PROBE));
  const exists = (target) => {
    try {
      fs.lstatSync(target);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const io = {
    written: 0,
    read(filePath, maxBytes) {
      if (!exists(path.dirname(filePath))) return null;
      guard(filePath);
      try {
        return ops.readJson(filePath, { maxBytes });
      } catch (error) {
        throw readFailure(error);
      }
    },
    list(dir) {
      guardDirectory(dir);
      return ops.listDir(dir);
    },
    // Serializes once, refuses an oversized document before touching the disk,
    // guards the nearest existing ancestor before creating directories, and
    // returns the bytes written.
    write(filePath, value, maxBytes) {
      const text = JSON.stringify(value);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > maxBytes) refuse('limit', 'team_chat_storage_limit');
      try {
        let ancestor = path.dirname(filePath);
        while (!exists(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
        guardDirectory(ancestor);
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        guard(filePath);
        ops.writeText(filePath, text);
      } catch (error) {
        // The file may have landed anyway (a directory fsync after the rename
        // can fail), so the caller learns which file it was.
        Object.assign(error, { duringWrite: true, filePath });
        throw error;
      }
      io.written += 1;
      return bytes;
    },
    // Best effort: false leaves the file a stray to sweep later.
    remove(filePath, channelId) {
      try {
        guard(filePath);
        ops.removeFile(filePath);
        return true;
      } catch (error) {
        if (error && error.code === 'ENOENT') return true;
        log('WARN', 'team_chat.remove_failed', { channel_id: channelId, code: error?.code || null });
        return false;
      }
    },
  };
  return io;
}

module.exports = { checked, corrupt, createFileIo, isTransient, refuse };
