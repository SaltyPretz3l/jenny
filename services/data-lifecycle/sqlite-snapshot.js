'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { DATA_ERROR_CODES } = require('../backend/error-codes');

const MAX_SQLITE_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const DATABASE_JOURNAL_SUFFIXES = Object.freeze(['-wal', '-shm']);
const SNAPSHOT_FILE_NAME = /^sqlite-snapshot-[0-9a-f]{16}\.db(?:-journal|-wal|-shm)?$/;
const STALE_SNAPSHOT_AGE_MS = 60 * 60 * 1000;

function snapshotError(reason, message) {
  return Object.assign(new Error(message), { code: DATA_ERROR_CODES.SOURCE_UNREADABLE, reason });
}

function regularFileSize(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function hasSqliteHeader(sourcePath) {
  const head = Buffer.alloc(SQLITE_HEADER.length);
  const fd = fs.openSync(sourcePath, 'r');
  try {
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

function readCapped(filePath, maxBytes) {
  if (fs.statSync(filePath).size > maxBytes) {
    throw snapshotError('source_too_large', 'An archive source exceeds the supported per-file size.');
  }
  return fs.readFileSync(filePath);
}

// A snapshot file only outlives its call when the process died mid-archive.
// It is a full copy of the database, so the next snapshot removes old ones.
function removeStaleSnapshots(stagingDir, now = Date.now()) {
  for (const dirent of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (!dirent.isFile() || !SNAPSHOT_FILE_NAME.test(dirent.name)) continue;
    const filePath = path.join(stagingDir, dirent.name);
    try {
      if (now - fs.lstatSync(filePath).mtimeMs >= STALE_SNAPSHOT_AGE_MS) fs.rmSync(filePath, { force: true });
    } catch {
      // Retried by the next snapshot.
    }
  }
}

function vacuumInto(sourcePath, snapshotPath) {
  const db = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false, timeout: 5000 });
  try {
    db.prepare('VACUUM INTO ?').run(snapshotPath);
  } finally {
    db.close();
  }
}

/**
 * Returns a consistent standalone copy of a SQLite database, including rows
 * that are committed only to its write-ahead log while another connection
 * still has the database open. A file that is not a SQLite database is
 * returned byte for byte so a damaged database stays in the archive. A
 * database that cannot be snapshotted next to a non-empty WAL throws rather
 * than yielding a copy that silently drops committed rows.
 *
 * @param {string} sourcePath
 * @param {{ stagingDir: string, maxBytes?: number }} options stagingDir holds the
 *   short-lived snapshot file and is created when missing.
 * @returns {Buffer}
 */
function snapshotSqliteDatabase(sourcePath, { stagingDir, maxBytes = MAX_SQLITE_SNAPSHOT_BYTES } = {}) {
  if (!stagingDir) throw new TypeError('snapshotSqliteDatabase requires stagingDir.');
  const walBytes = regularFileSize(`${sourcePath}-wal`);
  const sourceBytes = regularFileSize(sourcePath);
  if (sourceBytes > 0 ? !hasSqliteHeader(sourcePath) : walBytes === 0) {
    return readCapped(sourcePath, maxBytes);
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  removeStaleSnapshots(stagingDir);
  const snapshotPath = path.join(stagingDir, `sqlite-snapshot-${crypto.randomBytes(8).toString('hex')}.db`);
  try {
    try {
      vacuumInto(sourcePath, snapshotPath);
    } catch {
      if (walBytes > 0) {
        throw snapshotError('source_unreadable', 'An archive source database could not be snapshotted with its write-ahead log.');
      }
      return readCapped(sourcePath, maxBytes);
    }
    return readCapped(snapshotPath, maxBytes);
  } finally {
    for (const suffix of ['', '-journal', ...DATABASE_JOURNAL_SUFFIXES]) {
      fs.rmSync(`${snapshotPath}${suffix}`, { force: true });
    }
  }
}

/**
 * Expands a restore action for a database into actions for its `-wal` and
 * `-shm` siblings, so a stale journal is moved aside with the database it
 * belonged to instead of being replayed over the restored copy.
 */
function withDatabaseJournalActions(logicalPath, targetPath, owner) {
  const databaseAction = { targetPath, ...owner };
  if (!/^memory\/.+\.db$/.test(logicalPath)) return [databaseAction];
  return [
    databaseAction,
    ...DATABASE_JOURNAL_SUFFIXES.map((suffix) => ({ ...owner, targetPath: `${targetPath}${suffix}` })),
  ];
}

module.exports = {
  MAX_SQLITE_SNAPSHOT_BYTES,
  snapshotSqliteDatabase,
  withDatabaseJournalActions,
};
