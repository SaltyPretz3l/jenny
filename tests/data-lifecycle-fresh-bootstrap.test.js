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

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fresh-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await new PersonalityWorkspaceService({ userDataPath: root }).ensureSeeded();
  const file = path.join(root, 'sidecar-memory.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 8; PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);');
  for (const name of ['memory_extraction_runs', 'pending_memory_candidates', 'memory_suppressions', 'memory_quarantine']) {
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

for (const table of ['memories', 'memory_extraction_runs', 'pending_memory_candidates', 'memory_suppressions', 'memory_quarantine']) {
  test(`an authored ${table} record blocks full restore`, async t => {
    const { root, file } = await fixture(t);
    const db = new DatabaseSync(file);
    db.prepare(`INSERT INTO ${table}(content) VALUES (?)`).run('owner data');
    db.close();
    assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  });
}

for (const sql of ['PRAGMA user_version=9', 'CREATE TABLE owner_notes(content TEXT)', 'CREATE VIEW owner_notes AS SELECT 1']) {
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
    db.exec('PRAGMA user_version=8;');
    assert.ok(fs.statSync(file + '-wal').size > 0);
    assert.equal(isMeaningfullyFresh({ userDataPath: root }), true);
    db.prepare('INSERT INTO memories(content) VALUES (?)').run('owner memory');
    assert.equal(isMeaningfullyFresh({ userDataPath: root }), false);
  } finally { db.close(); }
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
