'use strict';

// Crash-orphaned atomic-write temps of the profile JSON stores (persistence
// faults O1 and O5). A kill between a store's temp write and its rename leaves
// one temp file beside the live file; the live file is always whole, but no
// store ever removes the temp, so they pile up one per crash. The session
// store's own temps are pruned by session-legacy-file-prune.js.

const fs = require('fs');
const path = require('path');

const ORPHANED_TEMP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// Name contracts, checked against the writers:
//   <name>.<Date.now()>.<12 hex>.tmp  FileJsonStore (shell config, Home journal,
//                                     project notes) and writeScheduledTasksFile
//   <name>.<pid>.<12 hex>.tmp         McpConfigStore._atomicReplace; the name has
//                                     no time, so the mtime alone is the age.
// The MCP store's `.rollback` file is never a candidate: it holds the previous
// config bytes.
const STAMPED_TEMP = /^(.+)\.(\d{10,16})\.[0-9a-f]{12}\.tmp$/;
const PID_TEMP = /^(.+)\.\d{1,9}\.[0-9a-f]{12}\.tmp$/;

// `dir` is relative to the profile root; `isLiveName` says which live file a
// temp may belong to. Each directory is owned by the listed store.
const TARGETS = Object.freeze([
  { dir: '', form: STAMPED_TEMP, isLiveName: (name) => name === 'shell-config.json' || name === 'home-ai-journal.json' },
  { dir: '', form: PID_TEMP, isLiveName: (name) => name === 'mcp-servers.json' },
  { dir: 'background-memory', form: STAMPED_TEMP, isLiveName: (name) => name === 'scheduled_tasks.json' },
  { dir: 'project-notes', form: STAMPED_TEMP, isLiveName: (name) => name.endsWith('.json') },
]);

function classifyProfileTemp(name, target) {
  const match = target.form.exec(name);
  if (!match || !target.isLiveName(match[1])) return null;
  return { stampMs: target.form === STAMPED_TEMP ? Number(match[2]) : 0 };
}

// Nothing is awaited between the file's final type/age check and its unlink.
async function pruneCandidate(filePath, record, stampMs, { now, minAgeMs, log, result, fsImpl }) {
  try {
    const stat = await fsImpl.promises.lstat(filePath);
    const ageMs = stampMs ? Math.min(now - stampMs, now - stat.mtimeMs) : now - stat.mtimeMs;
    if (!stat.isFile() || !(ageMs >= minAgeMs)) return;
    await fsImpl.promises.unlink(filePath);
    const deleted = { ...record, bytes: stat.size, ageMs: Math.round(ageMs) };
    result.deleted.push(deleted);
    log('INFO', 'profile_store.orphaned_temp_pruned', deleted);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    const failure = { ...record, error: String(error?.message || error) };
    result.failed.push(failure);
    log('WARN', 'profile_store.orphaned_temp_prune_failed', failure);
  }
}

// Deletes the temps above once they are older than 24 h by both the name's
// timestamp (when it has one) and the mtime, so an in-flight write is never
// touched. Only regular files that are direct children of the listed
// directories are candidates; no subdirectory is entered.
async function pruneOrphanedProfileTemps({
  profileRoot,
  now = Date.now(),
  minAgeMs = ORPHANED_TEMP_MIN_AGE_MS,
  log = () => {},
  fsImpl = fs,
} = {}) {
  const result = { deleted: [], failed: [] };
  if (typeof profileRoot !== 'string' || !profileRoot) return result;
  for (const target of TARGETS) {
    const dir = path.join(profileRoot, target.dir);
    let entries;
    try {
      entries = await fsImpl.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        const failure = { dir: target.dir, file: '', error: String(error?.message || error) };
        result.failed.push(failure);
        log('WARN', 'profile_store.orphaned_temp_prune_failed', failure);
      }
      continue;
    }
    for (const entry of entries) {
      const candidate = entry.isFile() ? classifyProfileTemp(entry.name, target) : null;
      if (candidate) {
        await pruneCandidate(path.join(dir, entry.name), { dir: target.dir, file: entry.name }, candidate.stampMs, {
          now, minAgeMs, log, result, fsImpl,
        });
      }
    }
  }
  return result;
}

module.exports = {
  ORPHANED_TEMP_MIN_AGE_MS,
  pruneOrphanedProfileTemps,
};
