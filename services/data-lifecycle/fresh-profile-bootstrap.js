'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { PLACEHOLDER_TEMPLATES, PERSONALITY_WORKSPACE_SCHEMA_VERSION } = require('../personality-workspace-service');
const runtimeArchive = require('./runtime-archive');

function regularPath(root, target, directory = false) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) return null;
  const expected = path.join(fs.realpathSync(root), path.relative(root, target));
  return fs.realpathSync(target) === expected ? stat : null;
}

function isUntouchedPersonalityBootstrap(root) {
  const directory = path.join(root, 'personality', 'default-workspace');
  try {
    if (!regularPath(root, directory, true)) return false;
    const names = fs.readdirSync(directory).sort();
    if (!names.length) return true;
    const templates = Object.fromEntries(Object.entries(PLACEHOLDER_TEMPLATES).map(([key, value]) => [`${key}.md`, value]));
    const stateName = '.personality-state.json';
    const expected = [stateName, ...Object.keys(templates)].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) return false;
    for (const name of names) {
      const file = path.join(directory, name);
      const stat = regularPath(root, file);
      if (!stat || stat.size > 4096) return false;
      const text = fs.readFileSync(file, 'utf8');
      if (name !== stateName) {
        if (text !== templates[name]) return false;
        continue;
      }
      const state = JSON.parse(text);
      if (state.version !== PERSONALITY_WORKSPACE_SCHEMA_VERSION
        || typeof state.migrated_at !== 'string' || !Number.isFinite(Date.parse(state.migrated_at))
        || Object.keys(state).some(key => !['version', 'migrated_at', 'migrated_files', 'archived_files', 'merged_from'].includes(key))
        || !['migrated_files', 'archived_files', 'merged_from'].every(key => Array.isArray(state[key]) && !state[key].length)) return false;
    }
    return true;
  } catch (error) { return error?.code === 'ENOENT' && !fs.existsSync(directory); }
}

const V9_EMPTY_MEMORY_TABLES = ['memories', 'sqlite_sequence', 'pending_memory_candidates',
  'memory_suppressions', 'memory_quarantine', 'memory_operations', 'memory_reflection_cursor',
  'memory_project_state', 'memory_session_markers', 'memory_fts', 'memory_fts_idx', 'memory_fts_docsize'];
const V9_TRIGGERS = ['memory_fts_insert', 'memory_fts_delete', 'memory_fts_update'];
function memorySchema(emptyTables, triggers) {
  return Object.freeze({ emptyTables, triggers,
    tables: [...emptyTables, 'memory_fts_data', 'memory_fts_config'].sort() });
}
// Untouched shapes per memory schema version; any other version stays closed.
// v9 is a profile created by the previous build. v10 (row 58 W4) adds the empty
// memory_vectors table and the triggers that drop a stale vector.
const MEMORY_SCHEMAS = new Map([
  [9, memorySchema(V9_EMPTY_MEMORY_TABLES, V9_TRIGGERS)],
  [10, memorySchema([...V9_EMPTY_MEMORY_TABLES, 'memory_vectors'],
    [...V9_TRIGGERS, 'memory_vectors_invalidate', 'memory_vectors_delete'])],
]);

function memoryJournalState(root, file) {
  if (fs.existsSync(file + '-journal')) return false;
  const state = {};
  for (const suffix of ['-wal', '-shm']) {
    if (!fs.existsSync(file + suffix)) continue;
    const stat = regularPath(root, file + suffix);
    if (!stat || stat.size > 8 * 1024 * 1024) return false;
    state[suffix] = { size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev };
  }
  if (state['-wal']?.size && !state['-shm']) return false;
  return state;
}

function isUntouchedMemoryBootstrap(root) {
  const file = path.join(root, 'sidecar-memory.db');
  let db;
  try {
    const before = regularPath(root, file);
    const journals = memoryJournalState(root, file);
    if (!before || before.size > 4 * 1024 * 1024 || !journals) return false;
    if (!before.size) return !journals['-wal']?.size;
    // Immutable mode prevents sidecar creation for a fully checkpointed file.
    // An active WAL requires SQLite's normal read-only snapshot. Require its
    // existing shared-memory file, so inspection never creates journal files.
    const uri = pathToFileURL(file).href + (journals['-wal']?.size ? '?mode=ro' : '?immutable=1');
    db = new DatabaseSync(uri, { readOnly: true, allowExtension: false, timeout: 0 });
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;');
    // Unknown versions stay closed; the sidecar owns memory schema migrations.
    const schema = MEMORY_SCHEMAS.get(db.prepare('PRAGMA user_version').get().user_version);
    if (!schema) return false;
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name);
    if (JSON.stringify(tables) !== JSON.stringify(schema.tables)) return false;
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'view' LIMIT 1").get()) return false;
    const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all();
    if (triggers.some(row => !schema.triggers.includes(row.name))) return false;
    if (db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') return false;
    if (schema.emptyTables.some(table => db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get())) return false;
    const after = regularPath(root, file);
    const finalJournals = memoryJournalState(root, file);
    // SQLite may update shared-memory read marks; durable WAL bytes must stay stable.
    return Boolean(after && finalJournals && JSON.stringify(journals['-wal']) === JSON.stringify(finalJournals['-wal'])
      && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs);
  } catch (error) { return error?.code === 'ENOENT' && !fs.existsSync(file); }
  finally { db?.close(); }
}

function listDirectoryEntries(targetPath) {
  try {
    return fs.readdirSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// Canonical stores only. Derived index caches (derived-indexes.js) are never
// consulted: they rebuild from canonical data and a restore promotion drops them.
function isMeaningfullyFresh({ userDataPath, sessionStore = null } = {}) {
  if (!String(userDataPath || '').trim()) return false;
  if (!runtimeArchive.isUntouchedProjectBootstrap(userDataPath)) return false;
  if (!runtimeArchive.isUntouchedRuntimeBootstrap(userDataPath)) return false;
  if (!runtimeArchive.isUntouchedRuntimeCoordinationBootstrap(userDataPath)) return false;
  if (!isUntouchedPersonalityBootstrap(userDataPath) || !isUntouchedMemoryBootstrap(userDataPath)) return false;
  if (sessionStore && typeof sessionStore.listSessions === 'function') {
    if ((sessionStore.listSessions() || []).length > 0) return false;
  } else if (listDirectoryEntries(path.join(userDataPath, 'sessions')).length > 0) {
    return false;
  }
  const meaningfulPaths = [
    path.join(userDataPath, 'sessions.json'),
    path.join(userDataPath, 'attachments'),
    path.join(userDataPath, 'home-calendar.json'),
  ];
  return meaningfulPaths.every((targetPath) => {
    try {
      const stat = fs.lstatSync(targetPath);
      return stat.isDirectory() ? listDirectoryEntries(targetPath).length === 0 : stat.size === 0;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  });
}

module.exports = { isMeaningfullyFresh, isUntouchedPersonalityBootstrap, isUntouchedMemoryBootstrap };
