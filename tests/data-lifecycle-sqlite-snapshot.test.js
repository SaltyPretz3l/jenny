'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { collectDataInventory } = require('../services/data-lifecycle/data-inventory');
const { createArchive, extractArchive, verifyArchive } = require('../services/data-lifecycle/archive-service');
const { promotePendingRestore, stageRestore } = require('../services/data-lifecycle/restore-service');
const { snapshotSqliteDatabase, withDatabaseJournalActions } = require('../services/data-lifecycle/sqlite-snapshot');

async function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-sqlite-snapshot-'));
  const open = [];
  try {
    return await run(root, (db) => { open.push(db); return db; });
  } finally {
    for (const db of open) {
      try { db.close(); } catch { /* already closed */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createWalDatabase(dbPath, track) {
  const db = track(new DatabaseSync(dbPath));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  db.prepare('INSERT INTO memories (body) VALUES (?)').run('committed only to the WAL');
  return db;
}

function countRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
  } finally {
    db.close();
  }
}

function stagingFiles(userDataPath) {
  const staging = path.join(userDataPath, 'data-lifecycle');
  return fs.existsSync(staging) ? fs.readdirSync(staging) : [];
}

function materialize(entry, userDataPath) {
  const stagingDir = path.join(userDataPath, 'data-lifecycle');
  fs.mkdirSync(stagingDir, { recursive: true });
  let produced;
  try {
    produced = entry.produce(stagingDir);
    return fs.readFileSync(produced.sourcePath);
  } finally {
    if (produced) fs.rmSync(produced.sourcePath, { force: true });
  }
}

describe('memory database archive entries', () => {
  it('restores rows that are committed only to the WAL of a database another connection holds open', () => withTempDir(async (root, track) => {
    const userDataPath = path.join(root, 'profile');
    const runtimePath = path.join(root, 'runtime');
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(runtimePath, { recursive: true });
    const dbPath = path.join(runtimePath, 'jenny_memory.db');
    createWalDatabase(dbPath, track);
    assert.ok(fs.statSync(`${dbPath}-wal`).size > 0);
    assert.equal(countRows(dbPath), 1);

    const inventory = collectDataInventory({ userDataPath, runtimePath });
    const entry = inventory.entries.find((item) => item.logicalPath === 'memory/jenny_memory.db');
    assert.equal(entry.category, 'memory');
    const data = materialize(entry, userDataPath);
    assert.ok(Buffer.isBuffer(data));
    assert.deepEqual(data.subarray(0, 16), Buffer.from('SQLite format 3\0', 'latin1'));
    assert.equal(inventory.counts.memory, 1);
    assert.deepEqual(stagingFiles(userDataPath), []);

    const created = await createArchive({
      destinationRoot: path.join(root, 'archives'),
      entries: inventory.entries,
      encrypted: false,
    });
    await verifyArchive(created.archivePath);
    const extractRoot = path.join(root, 'extracted');
    await extractArchive(created.archivePath, extractRoot);
    assert.equal(countRows(path.join(extractRoot, 'memory', 'jenny_memory.db')), 1);
  }));

  it('archives a file that is not a SQLite database byte for byte', () => withTempDir((root) => {
    const userDataPath = path.join(root, 'profile');
    const runtimePath = path.join(root, 'runtime');
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(runtimePath, { recursive: true });
    const damaged = Buffer.from('not a database, but still the user\'s data');
    fs.writeFileSync(path.join(userDataPath, 'sidecar-memory.db'), damaged);
    fs.writeFileSync(path.join(runtimePath, 'memory.db'), '');

    const { entries } = collectDataInventory({ userDataPath, runtimePath });
    assert.deepEqual(
      materialize(entries.find((item) => item.logicalPath === 'memory/sidecar-memory.db'), userDataPath),
      damaged
    );
    assert.equal(materialize(entries.find((item) => item.logicalPath === 'memory/legacy-memory.db'), userDataPath).length, 0);
    assert.deepEqual(stagingFiles(userDataPath), []);
  }));

  it('refuses an archive entry that would drop a non-empty WAL and leaves no snapshot file behind', () => withTempDir((root) => {
    const userDataPath = path.join(root, 'profile');
    const runtimePath = path.join(root, 'runtime');
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(runtimePath, { recursive: true });
    const header = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4096, 0xff)]);
    fs.writeFileSync(path.join(runtimePath, 'jenny_memory.db'), header);
    fs.writeFileSync(path.join(runtimePath, 'jenny_memory.db-wal'), Buffer.alloc(64, 1));

    const { entries } = collectDataInventory({ userDataPath, runtimePath });
    assert.throws(() => materialize(entries[0], userDataPath), {
      code: 'CMP-DATA-0004',
      reason: 'source_unreadable',
      message: 'An archive source database could not be snapshotted with its write-ahead log.',
    });
    assert.deepEqual(stagingFiles(userDataPath), []);
  }));

  it('keeps a damaged database with a valid header when there is no WAL to lose', () => withTempDir((root) => {
    const userDataPath = path.join(root, 'profile');
    fs.mkdirSync(userDataPath, { recursive: true });
    const damaged = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4096, 0xff)]);
    fs.writeFileSync(path.join(userDataPath, 'sidecar-memory.db'), damaged);

    const { entries } = collectDataInventory({ userDataPath });
    assert.deepEqual(materialize(entries.find((item) => item.logicalPath === 'memory/sidecar-memory.db'), userDataPath), damaged);
    assert.deepEqual(stagingFiles(userDataPath), []);
  }));

  it('fails closed when the snapshot exceeds the size cap and leaves no snapshot file behind', () => withTempDir((root, track) => {
    const dbPath = path.join(root, 'jenny_memory.db');
    createWalDatabase(dbPath, track);
    const stagingDir = path.join(root, 'staging');

    assert.throws(() => snapshotSqliteDatabase(dbPath, { stagingDir, maxBytes: 16 }), {
      code: 'CMP-DATA-0004',
      reason: 'source_too_large',
    });
    assert.deepEqual(fs.readdirSync(stagingDir), []);
  }));
});

describe('restore journal siblings', () => {
  it('moves the -wal and -shm files of a restored memory database aside with it', () => {
    const owner = { ownerRoot: '/runtime', ownerKey: 'runtime' };
    const actions = withDatabaseJournalActions('memory/jenny_memory.db', '/runtime/jenny_memory.db', owner);
    assert.deepEqual(actions.map((action) => action.targetPath), [
      '/runtime/jenny_memory.db',
      '/runtime/jenny_memory.db-wal',
      '/runtime/jenny_memory.db-shm',
    ]);
    assert.ok(actions.every((action) => action.ownerRoot === '/runtime' && action.ownerKey === 'runtime'));
    assert.equal(withDatabaseJournalActions('workspace/omissions/omissions.db', '/ws/omissions.db', owner).length, 1);
  });
});

describe('restoring a memory database', () => {
  it('does not replay a stale WAL left beside the restored database', () => withTempDir(async (root, track) => {
    const sourceDir = path.join(root, 'source');
    const userDataPath = path.join(root, 'profile');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(userDataPath, { recursive: true });
    createWalDatabase(path.join(sourceDir, 'sidecar-memory.db'), track);
    const { entries } = collectDataInventory({ userDataPath: sourceDir });
    const created = await createArchive({ destinationRoot: path.join(root, 'archives'), entries, encrypted: false });
    fs.writeFileSync(path.join(userDataPath, 'sidecar-memory.db-wal'), Buffer.alloc(64, 7));
    fs.writeFileSync(path.join(userDataPath, 'sidecar-memory.db-shm'), Buffer.alloc(64, 7));

    await stageRestore({ archivePath: created.archivePath, userDataPath });
    await promotePendingRestore({ userDataPath });

    assert.equal(fs.existsSync(path.join(userDataPath, 'sidecar-memory.db-wal')), false);
    assert.equal(fs.existsSync(path.join(userDataPath, 'sidecar-memory.db-shm')), false);
    assert.equal(countRows(path.join(userDataPath, 'sidecar-memory.db')), 1);
  }));
});

describe('workspace review inventory', () => {
  it('skips the memory database snapshots when asked to', () => withTempDir((root, track) => {
    const userDataPath = path.join(root, 'profile');
    const runtimePath = path.join(root, 'runtime');
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(runtimePath, { recursive: true });
    createWalDatabase(path.join(userDataPath, 'sidecar-memory.db'), track);
    createWalDatabase(path.join(runtimePath, 'jenny_memory.db'), track);

    const { entries } = collectDataInventory({ userDataPath, runtimePath, includeMemoryDatabases: false });

    assert.deepEqual(entries.filter((entry) => entry.logicalPath.startsWith('memory/')), []);
    assert.deepEqual(stagingFiles(userDataPath), []);
  }));
});
