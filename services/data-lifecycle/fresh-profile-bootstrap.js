'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { PLACEHOLDER_TEMPLATES, PERSONALITY_WORKSPACE_SCHEMA_VERSION } = require('../personality-workspace-service');

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

const EMPTY_MEMORY_TABLES = ['memories', 'sqlite_sequence', 'memory_extraction_runs', 'pending_memory_candidates',
  'memory_suppressions', 'memory_quarantine', 'memory_fts', 'memory_fts_idx', 'memory_fts_docsize'];
const MEMORY_TABLES = [...EMPTY_MEMORY_TABLES, 'memory_fts_data', 'memory_fts_config'].sort();

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
    if (db.prepare('PRAGMA user_version').get().user_version !== 8) return false;
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name);
    if (JSON.stringify(tables) !== JSON.stringify(MEMORY_TABLES)) return false;
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'view' LIMIT 1").get()) return false;
    const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all();
    if (triggers.some(row => !['memory_fts_insert', 'memory_fts_delete', 'memory_fts_update'].includes(row.name))) return false;
    if (db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') return false;
    if (EMPTY_MEMORY_TABLES.some(table => db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get())) return false;
    const after = regularPath(root, file);
    const finalJournals = memoryJournalState(root, file);
    // SQLite may update shared-memory read marks; durable WAL bytes must stay stable.
    return Boolean(after && finalJournals && JSON.stringify(journals['-wal']) === JSON.stringify(finalJournals['-wal'])
      && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs);
  } catch (error) { return error?.code === 'ENOENT' && !fs.existsSync(file); }
  finally { db?.close(); }
}

module.exports = { isUntouchedPersonalityBootstrap, isUntouchedMemoryBootstrap };
