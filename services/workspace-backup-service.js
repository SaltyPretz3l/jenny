'use strict';

// Row 82 E3 hot exit backups (main side). Stores unsaved editor buffers under
// <userData>/workspace-backups/<rootId>/<sha256(path)>.json so the Workspace IDE
// can offer them back after a crash or quit. The rootId comes from main's root
// context and never from the renderer; the path is a lexical workspace-relative
// path used only as data (the file name is its hash), so nothing here can reach
// outside the per-root backup directory. Content and paths are never logged.
//
// A write or remove names the root id and generation the renderer captured with its
// buffer (expectedRootId / expectedGeneration); main passes its current generation and
// a mismatch is refused with INVALID_ROOT before any filesystem access, so a buffer that
// settles during a root switch never lands under the new root. list() is stat-only: it
// answers record ids (the hashed names), sizes and times, and a record is parsed only
// when read() asks for it by id or path.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJsonAtomicAsync } = require('./backend/session-storage-fs-utils');
const { WORKSPACE_BACKUP_ERROR_CODES: CODES } = require('./backend/error-codes');
const { isWorkspaceIdeRecord, normalizeWorkspaceIdeRelativePath } = require('./workspace-ide-config-schema');

const BACKUP_DIRECTORY = 'workspace-backups';
const ROOT_ID_PATTERN = /^root_[0-9a-f]{24}$/;
const BACKUP_ID_PATTERN = /^[0-9a-f]{64}$/;
const BACKUP_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;
const MAX_PATH_LENGTH = 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 50,
  maxRootBytes: 64 * 1024 * 1024,
});

const MESSAGES = Object.freeze({
  [CODES.INVALID_ROOT]: 'The workspace root identifier is not valid.',
  [CODES.INVALID_PATH]: 'The backup path must be a normalized workspace-relative path.',
  [CODES.INVALID_PAYLOAD]: 'The backup payload is not valid.',
  [CODES.TOO_LARGE]: 'The unsaved file is too large to back up.',
  [CODES.QUOTA_EXCEEDED]: 'The workspace backup store is full.',
  [CODES.IO_FAILED]: 'The backup could not be read or written.',
});

function fail(code) {
  return { ok: false, code, message: MESSAGES[code] || '' };
}

function hashPath(relativePath) {
  return createHash('sha256').update(relativePath, 'utf8').digest('hex');
}

function validRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PATH_LENGTH
    && normalizeWorkspaceIdeRelativePath(value) === value;
}

function createWorkspaceBackupService({
  userDataPath,
  now = Date.now,
  limits = {},
  log = null,
} = {}) {
  const cap = { ...DEFAULT_LIMITS, ...limits };
  const baseDirectory = path.join(String(userDataPath || ''), BACKUP_DIRECTORY);
  const maxRecordBytes = cap.maxFileBytes * 2 + 4096;
  let queue = Promise.resolve();

  function logCode(event, code) {
    if (typeof log !== 'function') return;
    try { log('WARN', event, { code }); } catch (_error) { void _error; }
  }

  // Writes and quota scans share one lane so two writes can never both pass the
  // same cap check.
  function serial(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function rootDirectory(rootId) {
    return typeof rootId === 'string' && ROOT_ID_PATTERN.test(rootId) ? path.join(baseDirectory, rootId) : null;
  }

  // The one validation prologue: a valid root, a plain-object payload, for a mutation
  // the captured scope (main's generation and root id), then the record name from the
  // path (or, for read, an id). Answers { failure } or { directory, name }.
  function admit(rootId, payload, { generation, mutation = false, allowId = false } = {}) {
    const directory = rootDirectory(rootId);
    if (!directory) return { failure: fail(CODES.INVALID_ROOT) };
    if (!isWorkspaceIdeRecord(payload)) return { failure: fail(CODES.INVALID_PAYLOAD) };
    if (mutation && (!Number.isSafeInteger(generation)
      || payload.expectedRootId !== rootId
      || payload.expectedGeneration !== generation)) {
      return { failure: fail(CODES.INVALID_ROOT) };
    }
    if (allowId && payload.id !== undefined) {
      return typeof payload.id === 'string' && BACKUP_ID_PATTERN.test(payload.id)
        ? { directory, name: `${payload.id}.json` }
        : { failure: fail(CODES.INVALID_PATH) };
    }
    if (!validRelativePath(payload.path)) return { failure: fail(CODES.INVALID_PATH) };
    return { directory, name: `${hashPath(payload.path)}.json` };
  }

  async function discard(filePath) {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') logCode('workspace_backup.discard_failed', CODES.IO_FAILED);
    }
  }

  // Record files of a root with their lstat; links and other non-files are skipped.
  async function listRecords(directory) {
    let names;
    try {
      names = (await fs.promises.readdir(directory)).filter((name) => BACKUP_FILE_PATTERN.test(name));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const name of names) {
      try {
        const stat = await fs.promises.lstat(path.join(directory, name));
        if (stat.isFile()) records.push({ name, stat });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return records;
  }

  // Returns a validated entry, or null after deleting an unusable file. A file
  // whose recorded path does not hash to its own name is dropped so it can never
  // be restored onto the wrong path.
  async function loadEntry(directory, name) {
    const filePath = path.join(directory, name);
    let raw;
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile()) return null;
      if (stat.size > maxRecordBytes) {
        await discard(filePath);
        return null;
      }
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      logCode('workspace_backup.read_failed', CODES.IO_FAILED);
      await discard(filePath);
      return null;
    }
    let value;
    try { value = JSON.parse(raw); } catch (_error) { value = null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1
      || !validRelativePath(value.path)
      || `${hashPath(value.path)}.json` !== name
      || typeof value.content !== 'string'
      || Buffer.byteLength(value.content, 'utf8') > cap.maxFileBytes
      || !Number.isFinite(value.diskMtimeMs)
      || !Number.isFinite(value.updatedAt)) {
      await discard(filePath);
      return null;
    }
    return { path: value.path, content: value.content, diskMtimeMs: value.diskMtimeMs, updatedAt: value.updatedAt };
  }

  // Runs one serialized task, answering IO_FAILED (code only, never paths) on a throw.
  function guarded(event, task) {
    return serial(async () => {
      try {
        return await task();
      } catch (_error) {
        void _error;
        logCode(event, CODES.IO_FAILED);
        return fail(CODES.IO_FAILED);
      }
    });
  }

  async function write(rootId, payload, generation) {
    const { failure, directory, name } = admit(rootId, payload, { generation, mutation: true });
    if (failure) return failure;
    if (typeof payload.content !== 'string') return fail(CODES.INVALID_PAYLOAD);
    if (Buffer.byteLength(payload.content, 'utf8') > cap.maxFileBytes) return fail(CODES.TOO_LARGE);
    const record = {
      version: 1,
      path: payload.path,
      content: payload.content,
      diskMtimeMs: Number.isFinite(payload.diskMtimeMs) ? payload.diskMtimeMs : 0,
      updatedAt: Number(now()),
    };
    const size = Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8');
    return guarded('workspace_backup.write_failed', async () => {
      let files = 0;
      let bytes = 0;
      for (const existing of await listRecords(directory)) {
        if (existing.name === name) continue; // an update replaces its own entry
        bytes += existing.stat.size;
        files += 1;
      }
      if (files + 1 > cap.maxFiles || bytes + size > cap.maxRootBytes) return fail(CODES.QUOTA_EXCEEDED);
      const filePath = path.join(directory, name);
      await writeJsonAtomicAsync(filePath, record);
      // list() orders by the file time, so it carries updatedAt (best effort).
      const seconds = record.updatedAt / 1000;
      await fs.promises.utimes(filePath, seconds, seconds).catch(() => {});
      return { ok: true, bytes: size };
    });
  }

  async function remove(rootId, payload, generation) {
    const { failure, directory, name } = admit(rootId, payload, { generation, mutation: true });
    if (failure) return failure;
    return guarded('workspace_backup.remove_failed', async () => {
      try {
        await fs.promises.unlink(path.join(directory, name));
        return { ok: true, removed: true };
      } catch (error) {
        if (error?.code === 'ENOENT') return { ok: true, removed: false };
        throw error;
      }
    });
  }

  async function list(rootId) {
    const directory = rootDirectory(rootId);
    if (!directory) return fail(CODES.INVALID_ROOT);
    return guarded('workspace_backup.list_failed', async () => {
      const entries = [];
      for (const { name, stat } of await listRecords(directory)) {
        if (stat.size > maxRecordBytes) {
          await discard(path.join(directory, name));
          continue;
        }
        entries.push({ id: name.slice(0, -'.json'.length), updatedAt: Math.round(stat.mtimeMs), bytes: stat.size });
      }
      entries.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      return { ok: true, entries };
    });
  }

  async function read(rootId, payload) {
    const { failure, directory, name } = admit(rootId, payload, { allowId: true });
    if (failure) return failure;
    return guarded('workspace_backup.read_failed', async () => {
      const entry = await loadEntry(directory, name);
      return { ok: true, entry };
    });
  }

  return { write, remove, list, read };
}

module.exports = { createWorkspaceBackupService, DEFAULT_LIMITS };
