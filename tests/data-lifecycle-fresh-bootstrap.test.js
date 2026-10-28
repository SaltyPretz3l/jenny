'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PersonalityWorkspaceService } = require('../services/personality-workspace-service');
const { isMeaningfullyFresh } = require('../services/data-lifecycle/restore-service');

const MEMORY_ROW_TABLES = ['memories', 'pending_memory_candidates', 'memory_suppressions', 'memory_quarantine',
  'memory_operations', 'memory_reflection_cursor', 'memory_project_state', 'memory_session_markers'];

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fresh-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await new PersonalityWorkspaceService({ userDataPath: root }).ensureSeeded();
  const file = path.join(root, 'sidecar-memory.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 9; PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);');
  for (const name of MEMORY_ROW_TABLES.slice(1)) {
    db.exec(`CREATE TABLE ${name}(content TEXT);`);
  }
  db.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memories', content_rowid='id');");
  db.close();
  return { root, file };
}

test('actual personality bootstrap and empty known memory schema remain fresh without writes', async t => {
  const { root, file } = await fixture(t);
  const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash();
  const names = fs.readdirSync(root).sort();
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), true);
  assert.equal(hash(), before);
  assert.deepEqual(fs.readdirSync(root).sort(), names, 'inspection must not create WAL/SHM files');
});

for (const table of MEMORY_ROW_TABLES) {
  test(`an authored ${table} record blocks full restore`, async t => {
    const { root, file } = await fixture(t);
    const db = new DatabaseSync(file);
    db.prepare(`INSERT INTO ${table}(content) VALUES (?)`).run('owner data');
    db.close();
    assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  });
}

for (const sql of ['PRAGMA user_version=10', 'PRAGMA user_version=8', 'CREATE TABLE memory_extraction_runs(content TEXT)',
  'CREATE TABLE owner_notes(content TEXT)', 'CREATE VIEW owner_notes AS SELECT 1']) {
  test(`unknown memory state stays closed: ${sql}`, async t => {
    const { root, file } = await fixture(t);
    const db = new DatabaseSync(file); db.exec(sql); db.close();
    assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  });
}

test('authored personality bytes and archived migration state block restore', async t => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'personality', 'default-workspace');
  const file = path.join(directory, 'USER.md');
  const original = fs.readFileSync(file);
  fs.appendFileSync(file, '\nOwner preference');
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  fs.writeFileSync(file, original);
  const stateFile = path.join(directory, '.personality-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile)); state.archived_files.push('owner.md');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
});

test('live empty WAL snapshot is fresh, but a subsequent committed memory blocks restore', async t => {
  const { root, file } = await fixture(t);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA user_version=9;');
    assert.ok(fs.statSync(file + '-wal').size > 0);
    assert.equal(isMeaningfullyFresh({ userDataPath: root }), true);
    db.prepare('INSERT INTO memories(content) VALUES (?)').run('owner memory');
    assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  } finally { db.close(); }
});

// Schema v10 (row 58 W4) adds memory_vectors and its invalidation trigger.
function upgradeFixtureToV10(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = 10;
    CREATE TABLE memory_vectors(memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      content_fingerprint TEXT NOT NULL, model_key TEXT NOT NULL, dim INTEGER NOT NULL, norm REAL NOT NULL,
      blob BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE TRIGGER memory_vectors_invalidate AFTER UPDATE ON memories
      BEGIN DELETE FROM memory_vectors WHERE memory_id = old.id; END;
    CREATE TRIGGER memory_vectors_delete AFTER DELETE ON memories
      BEGIN DELETE FROM memory_vectors WHERE memory_id = old.id; END;`);
  db.close();
}

test('an untouched v10 memory store with an empty memory_vectors table is fresh', async t => {
  const { root, file } = await fixture(t);
  upgradeFixtureToV10(file);
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), true);
});

test('a v10 memory store with a vector row or an unknown trigger blocks restore', async t => {
  const { root, file } = await fixture(t);
  upgradeFixtureToV10(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('INSERT INTO memory_vectors VALUES (1, ?, ?, 1, 1, ?, ?)').run('fp', 'model', Buffer.alloc(4), 'now');
  db.close();
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  const other = await fixture(t);
  upgradeFixtureToV10(other.file);
  const second = new DatabaseSync(other.file);
  second.exec('CREATE TRIGGER owner_audit AFTER INSERT ON memories BEGIN SELECT 1; END;');
  second.close();
  assert.equal(isMeaningfullyFresh({ userDataPath: other.root }), false);
});

test('v9 tables at user_version 10, and memory_vectors at user_version 9, stay closed', async t => {
  const { root, file } = await fixture(t);
  upgradeFixtureToV10(file);
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version = 9'); db.close();
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
});

test('derived index caches never make a profile non-fresh', async t => {
  const { root } = await fixture(t);
  for (const name of ['semantic-catalog.db', 'semantic-catalog.db-wal', 'conversation-index.db',
    'conversation-index.db-shm', 'conversation-index.db.corrupt-20261015T120000123456Z']) {
    fs.writeFileSync(path.join(root, name), 'derived bytes');
  }
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), true);
});

test('the empty primary Jenny chat minted at first launch keeps the profile fresh; a message or another chat does not', async t => {
  const { root } = await fixture(t);
  const primary = { id: 'sess_primary', session_role: 'primary', message_count: 0, title: 'Jenny' };
  const storeWith = (...summaries) => ({ listSessions: () => summaries });
  assert.equal(isMeaningfullyFresh({ userDataPath: root, sessionStore: storeWith(primary) }), true);
  assert.equal(isMeaningfullyFresh({ userDataPath: root, sessionStore: storeWith({ ...primary, message_count: 2 }) }), false);
  assert.equal(isMeaningfullyFresh({ userDataPath: root, sessionStore: storeWith(primary, { id: 'sess_other', message_count: 0 }) }), false);
  assert.equal(isMeaningfullyFresh({ userDataPath: root, sessionStore: storeWith({ id: 'sess_plain', message_count: 0 }) }), false);
});

test('without a store, the sessions directory of an untouched primary chat is fresh; a message or any other file is not', async t => {
  const { root } = await fixture(t);
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir);
  const id = 'sess_1_primary';
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  write('_index.json', { journal_epoch: 1, schema_version: 26, sessions: { [id]: { id, session_role: 'primary', message_count: 0 } } });
  write('_active_turns.state', { version: 1, schema_version: 26, session_ids: [] });
  write(`${id}.json`, { journal_epoch: 1, schema_version: 26, session: { id, session_role: 'primary', messages: [] } });
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), true);

  write(`${id}.json`, { session: { id, session_role: 'primary', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false, 'a message in the record');
  write(`${id}.json`, { session: { id, session_role: 'primary', messages: [] } });
  write('_active_turns.state', { version: 1, session_ids: [id] });
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false, 'an active turn');
  write('_active_turns.state', { version: 1, session_ids: [] });
  write('sess_2_other.json', { session: { id: 'sess_2_other', messages: [] } });
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false, 'a record the index does not name');
  fs.rmSync(path.join(dir, 'sess_2_other.json'));
  write('_index.json', { sessions: { [id]: { id, session_role: null, message_count: 0 } } });
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false, 'a chat that is not the primary');
  fs.writeFileSync(path.join(dir, '_index.json'), '{not json');
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false, 'an unreadable index');
});

test('pending WAL bytes and linked personality directories block restore', async t => {
  const { root, file } = await fixture(t);
  fs.writeFileSync(file + '-wal', 'unsettled');
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  fs.unlinkSync(file + '-wal');
  const personality = path.join(root, 'personality');
  const moved = path.join(root, 'saved-personality');
  fs.renameSync(personality, moved);
  fs.symlinkSync(moved, personality, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
});
