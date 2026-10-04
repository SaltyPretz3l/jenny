'use strict';

const fs = require('fs');
const path = require('path');

const { deriveSessionsDirectory } = require('./session-storage-fs-utils');
const { LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION } = require('./session-store-migrations');

const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHANED_TMP_MIN_AGE_MS = DAY_MS;
const MIGRATION_BACKUP_MIN_AGE_MS = 30 * DAY_MS;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Name contracts of the two leftovers next to the legacy monolithic file:
//   <name>.<Date.now()>.<12 hex>.tmp  FileJsonStore / writeJsonAtomicAsync temp,
//                                     orphaned when a crash hit before the rename
//   <name>.migrated-<Date.now()>      the pre-split backup session-storage-migration
//                                     renames the monolithic file to (never read)
function classifyLegacyFile(name, baseName) {
  const base = escapeRegExp(baseName);
  const tmp = new RegExp(`^${base}\\.(\\d{10,16})\\.[0-9a-f]{12}\\.tmp$`).exec(name);
  if (tmp) {
    return { kind: 'orphaned_tmp', stampMs: Number(tmp[1]), minAgeMs: ORPHANED_TMP_MIN_AGE_MS };
  }
  const backup = new RegExp(`^${base}\\.migrated-(\\d{10,16})$`).exec(name);
  if (backup) {
    return { kind: 'migration_backup', stampMs: Number(backup[1]), minAgeMs: MIGRATION_BACKUP_MIN_AGE_MS };
  }
  return null;
}

// `<anything>.json.<Date.now()>.<12 hex>.tmp` inside the split sessions
// directory: the atomic-write temp of a chat file or of `_index.json`.
const SPLIT_TMP_NAME = /\.json\.(\d{10,16})\.[0-9a-f]{12}\.tmp$/;

function classifySplitStoreTmp(name) {
  const tmp = SPLIT_TMP_NAME.exec(name);
  return tmp
    ? { kind: 'orphaned_tmp', stampMs: Number(tmp[1]), minAgeMs: ORPHANED_TMP_MIN_AGE_MS }
    : null;
}

// A migration backup is only deletable while the split store it was migrated
// into is present and readable: a real directory (not a link) holding a real,
// parseable post-monolithic index.
async function isSplitStoreReadable(sessionsDir) {
  try {
    const dirStat = await fs.promises.lstat(sessionsDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
    const indexPath = path.join(sessionsDir, '_index.json');
    const indexStat = await fs.promises.lstat(indexPath);
    if (!indexStat.isFile()) {
      return false;
    }
    const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
    const version = Number(index?.schema_version);
    const sessions = index?.sessions;
    return Number.isFinite(version)
      && version > LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION
      && Boolean(sessions) && typeof sessions === 'object' && !Array.isArray(sessions);
  } catch (_error) {
    return false;
  }
}

// The store check runs per backup and BEFORE the lstat, so nothing is awaited
// between the file's final type/age check and its unlink.
async function pruneCandidate(filePath, name, candidate, { now, log, result, sessionsDir }) {
  try {
    if (candidate.kind === 'migration_backup' && !(await isSplitStoreReadable(sessionsDir))) {
      result.skippedBackups += 1;
      return;
    }
    const stat = await fs.promises.lstat(filePath);
    const ageMs = Math.min(now - candidate.stampMs, now - stat.mtimeMs);
    if (!stat.isFile() || !(ageMs >= candidate.minAgeMs)) {
      return;
    }
    await fs.promises.unlink(filePath);
    const record = { file: name, kind: candidate.kind, bytes: stat.size, ageMs: Math.round(ageMs) };
    result.deleted.push(record);
    log('INFO', 'session_store.legacy_file_pruned', record);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    const failure = { file: name, kind: candidate.kind, error: String(error?.message || error) };
    result.failed.push(failure);
    log('WARN', 'session_store.legacy_file_prune_failed', failure);
  }
}

// Orphaned atomic-write temps directly inside the split sessions directory;
// `corrupt/` and every other subdirectory are never entered.
async function pruneSplitStoreTemps(sessionsDir, { now, log, result }) {
  let entries;
  try {
    entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      const failure = { file: path.basename(sessionsDir), kind: 'scan', error: String(error?.message || error) };
      result.failed.push(failure);
      log('WARN', 'session_store.legacy_file_prune_failed', failure);
    }
    return;
  }
  for (const entry of entries) {
    const candidate = entry.isFile() ? classifySplitStoreTmp(entry.name) : null;
    if (candidate) {
      await pruneCandidate(path.join(sessionsDir, entry.name), entry.name, candidate, { now, log, result });
    }
  }
}

// Deletes stale leftovers of the legacy monolithic session file from the
// profile root: orphaned atomic-write temps older than 24 h and migration
// backups older than 30 days (only while the split store verifies readable).
// Age is the younger of the name's timestamp and the mtime, so an in-flight
// write (seconds old by both) is never touched. Only regular files that are
// direct children of the profile root and match the name contract are
// candidates; links, directories, the live `<name>` file and the `<name>/`
// store never are. Orphaned atomic-write temps in the split `sessions/`
// directory follow the same age rule. One log entry per deletion.
async function pruneLegacySessionFiles({ legacyFilePath, now = Date.now(), log = () => {} } = {}) {
  const result = { deleted: [], failed: [], skippedBackups: 0 };
  if (typeof legacyFilePath !== 'string' || !legacyFilePath) {
    return result;
  }
  const rootDir = path.dirname(legacyFilePath);
  const baseName = path.basename(legacyFilePath);
  let entries;
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      const failure = { file: rootDir, kind: 'scan', error: String(error?.message || error) };
      result.failed.push(failure);
      log('WARN', 'session_store.legacy_file_prune_failed', failure);
    }
    return result;
  }
  const sessionsDir = deriveSessionsDirectory(legacyFilePath);
  for (const entry of entries) {
    const candidate = entry.isFile() ? classifyLegacyFile(entry.name, baseName) : null;
    if (candidate) {
      await pruneCandidate(path.join(rootDir, entry.name), entry.name, candidate, {
        now, log, result, sessionsDir,
      });
    }
  }
  await pruneSplitStoreTemps(sessionsDir, { now, log, result });
  if (result.skippedBackups > 0) {
    log('WARN', 'session_store.legacy_backup_kept', {
      count: result.skippedBackups,
      reason: 'split_store_unreadable',
    });
  }
  return result;
}

module.exports = {
  MIGRATION_BACKUP_MIN_AGE_MS,
  ORPHANED_TMP_MIN_AGE_MS,
  classifyLegacyFile,
  pruneLegacySessionFiles,
};
