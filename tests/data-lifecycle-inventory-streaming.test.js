'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { finished } = require('stream/promises');
const exportsPort = require('../services/backend/session-export-import');
const snapshotsPort = require('../services/data-lifecycle/sqlite-snapshot');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createArchive, extractArchive } = require('../services/data-lifecycle/archive-service');
const { stageRestore, promotePendingRestore } = require('../services/data-lifecycle/restore-service');

function tempRoot(t) {
  fs.mkdirSync(path.join(__dirname, '..', '.tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.tmp', 'mem-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function loadInventory(t) {
  const modules = ['../services/data-lifecycle/data-inventory', '../services/data-lifecycle/data-lifecycle-service'];
  for (const name of modules) {
    const id = require.resolve(name);
    const previous = require.cache[id];
    delete require.cache[id];
    t.after(() => { if (previous) require.cache[id] = previous; else delete require.cache[id]; });
  }
  return require('../services/data-lifecycle/data-inventory');
}

test('workspace preview never exports sessions or touches memory databases', async (t) => {
  const root = tempRoot(t);
  const profile = path.join(root, 'profile');
  const runtime = path.join(root, 'runtime');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile);
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.join(workspace, '.jenny', 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.jenny', 'artifacts', 'keep.txt'), 'keep');
  const dbPaths = [path.join(profile, 'sidecar-memory.db'), path.join(runtime, 'jenny_memory.db')];
  for (const file of dbPaths) fs.writeFileSync(file, 'not a database');
  const exportSpy = t.mock.method(exportsPort, 'exportSession', () => {
    throw new Error('workspace preview exported a session');
  });
  const exists = fs.existsSync;
  const stat = fs.lstatSync;
  const read = fs.readFileSync;
  for (const [name, original] of [['existsSync', exists], ['lstatSync', stat], ['readFileSync', read]]) {
    t.mock.method(fs, name, (file, ...args) => {
      assert.equal(dbPaths.includes(String(file)), false, 'preview touched a memory database');
      return original(file, ...args);
    });
  }
  loadInventory(t);
  const { DataLifecycleService } = require('../services/data-lifecycle/data-lifecycle-service');
  const service = new DataLifecycleService({
    userDataPath: profile, runtimePath: runtime, documentsPath: path.join(root, 'documents'),
    shellConfigService: { getState: () => ({ toolsWorkspaceRoot: workspace }) },
    sessionStore: { listSessions: () => [{ id: 'sess_unused' }], getSession: () => ({ messages: [] }) },
  });
  const result = await service.previewWorkspaceArchive();
  assert.equal(exportSpy.mock.callCount(), 0, 'workspace preview must never call session export');
  assert.equal(result.ok, true);
  assert.equal(result.itemCount, 1);
  assert.equal(result.totalBytes, 4);
});

test('many media sessions are produced and consumed one at a time and restore identically', async (t) => {
  const root = tempRoot(t);
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  const databaseBytes = Buffer.from('damaged database bytes must survive');
  fs.writeFileSync(path.join(profile, 'sidecar-memory.db'), databaseBytes);
  fs.writeFileSync(path.join(runtime, 'jenny_memory.db'), databaseBytes);
  const media = path.join(root, 'media.webm');
  // EBML/WebM signature: audio intake sniffs the bytes and refuses non-audio.
  const mediaBytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('portable managed audio')]);
  fs.writeFileSync(media, mediaBytes);
  const sessions = Array.from({ length: 24 }, (_, index) => ({
    id: `sess_stream_${index}`, title: `Chat ${index}`, created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    messages: [{ id: `msg_${index}`, role: 'user', content: `Keep ${index}`,
      attachments: [{ id: `audio_${index}`, kind: 'audio', mimeType: 'audio/webm', assetPath: media }] }],
  }));
  const store = { listSessions: () => sessions, getSession: (id) => sessions.find((session) => session.id === id) };
  const originalExport = exportsPort.exportSession;
  let awaitingConsumption = false;
  let overlapped = false;
  let produced = 0;
  let snapshots = 0;
  const spoolPaths = [];
  const consumption = [];
  t.mock.method(exportsPort, 'exportSession', (...args) => {
    if (awaitingConsumption) overlapped = true;
    awaitingConsumption = true;
    produced += 1;
    return originalExport(...args);
  });
  const originalSnapshot = snapshotsPort.snapshotSqliteDatabase;
  t.mock.method(snapshotsPort, 'snapshotSqliteDatabase', (...args) => {
    if (awaitingConsumption) overlapped = true;
    awaitingConsumption = true;
    snapshots += 1;
    return originalSnapshot(...args);
  });
  const { collectDataInventory } = loadInventory(t);
  const inventory = collectDataInventory({ userDataPath: profile, runtimePath: runtime, sessionStore: store,
    attachmentStore: { resolveSafePath: () => media } });
  assert.equal(produced, 0, 'inventory must defer all session exports');
  assert.equal(snapshots, 0, 'inventory must defer all database snapshots');
  assert.equal(inventory.entries.filter((entry) => entry.category === 'chats').every((entry) => !entry.data), true);
  const readStream = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (file, ...args) => {
    const stream = readStream(file, ...args);
    if (awaitingConsumption) {
      spoolPaths.push(String(file));
      consumption.push(finished(stream).then(() => { awaitingConsumption = false; }));
    }
    return stream;
  });
  const created = await createArchive({ destinationRoot: path.join(root, 'archives'), entries: inventory.entries, encrypted: false });
  await Promise.all(consumption);
  assert.equal(produced, sessions.length);
  assert.equal(snapshots, 2);
  assert.equal(overlapped, false, 'previous export must be consumed before producing the next');
  assert.equal(spoolPaths.length, sessions.length + snapshots);
  assert.ok(spoolPaths.every((file) => !fs.existsSync(file)), 'all consumed spool files must be removed');
  const extracted = path.join(root, 'extracted');
  await extractArchive(created.archivePath, extracted);
  for (const entry of inventory.entries.filter((item) => item.category === 'chats')) {
    const archived = JSON.parse(fs.readFileSync(path.join(extracted, entry.logicalPath), 'utf8'));
    const expected = JSON.parse(originalExport(store, entry.restoreMetadata.session_id, { resolveSafePath: () => media },
      { requireManagedMedia: true, includeTurnEvents: true }));
    delete archived.exported_at;
    delete expected.exported_at;
    assert.deepEqual(archived, expected);
  }
  const restoredProfile = path.join(root, 'restored');
  fs.mkdirSync(restoredProfile);
  const restoredRuntime = path.join(root, 'restored-runtime');
  fs.mkdirSync(restoredRuntime);
  await stageRestore({ archivePath: created.archivePath, userDataPath: restoredProfile, runtimePath: restoredRuntime });
  await promotePendingRestore({ userDataPath: restoredProfile, runtimePath: restoredRuntime });
  assert.deepEqual(fs.readFileSync(path.join(restoredProfile, 'sidecar-memory.db')), databaseBytes);
  assert.deepEqual(fs.readFileSync(path.join(restoredRuntime, 'jenny_memory.db')), databaseBytes);
  const restoredStore = new ElectronSessionStore(path.join(restoredProfile, 'sessions.json'));
  for (const session of sessions) {
    const restored = restoredStore.getSession(session.id);
    assert.equal(restored.title, session.title);
    assert.equal(restored.messages[0].content, session.messages[0].content);
    assert.deepEqual(fs.readFileSync(restored.messages[0].attachments[0].assetPath), mediaBytes);
  }
  // Deferred failures must remove operation staging and partial output as well.
  const emptyProfile = path.join(root, 'failure-profile');
  fs.mkdirSync(emptyProfile);
  const failureRoot = path.join(root, 'failed-archives');
  const oversized = collectDataInventory({ userDataPath: emptyProfile, sessionStore: store,
    attachmentStore: { resolveSafePath: () => media }, maxFileBytes: 4 });
  await assert.rejects(createArchive({ destinationRoot: failureRoot, entries: oversized.entries, encrypted: false }),
    /A Jenny data item exceeds the supported archive size/);
  assert.deepEqual(fs.readdirSync(failureRoot), []);
  assert.deepEqual(fs.readdirSync(emptyProfile), []);
  awaitingConsumption = false;
  const missingMedia = collectDataInventory({ userDataPath: emptyProfile, sessionStore: store,
    attachmentStore: { resolveSafePath: () => '' } });
  await assert.rejects(createArchive({ destinationRoot: failureRoot, entries: missingMedia.entries, encrypted: false }), {
    code: 'CMP-DATA-0004', reason: 'source_unreadable', message: 'Managed session media could not be archived.',
  });
  assert.deepEqual(fs.readdirSync(failureRoot), []);
  assert.deepEqual(fs.readdirSync(emptyProfile), []);
});

test('encrypted archives stage produced plaintext under the profile, never at the destination', async (t) => {
  const root = tempRoot(t);
  const destinationRoot = path.join(root, 'archives');
  const stagingRoot = path.join(root, 'profile', 'data-lifecycle');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stale = path.join(stagingRoot, '.inventory-stale');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'leftover'), 'plaintext');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const stagedDirs = [];
  const entry = () => ({
    logicalPath: 'chats/session.json',
    category: 'chats',
    size: 9,
    produce(stagingDir) {
      stagedDirs.push(stagingDir);
      assert.equal(fs.existsSync(stale), false, 'stale staging must be swept before producing');
      const sourcePath = path.join(stagingDir, 'export.json');
      fs.writeFileSync(sourcePath, 'plaintext');
      return { sourcePath, size: 9 };
    },
  });
  const passphrase = 'correct horse battery staple 42';
  await assert.rejects(createArchive({ destinationRoot, entries: [entry()], encrypted: true, passphrase }), TypeError);
  const created = await createArchive({ destinationRoot, entries: [entry()], encrypted: true, passphrase, stagingRoot });
  assert.equal(stagedDirs.length, 1);
  assert.equal(path.dirname(stagedDirs[0]), stagingRoot);
  assert.equal(fs.existsSync(stagedDirs[0]), false, 'entry staging must be removed after use');
  const archived = fs.readdirSync(created.archivePath, { recursive: true }).map(String);
  assert.equal(archived.some((name) => name.includes('.inventory-')), false);
});

test('encrypted archives refuse a profile staging root redirected by a junction', async (t) => {
  const root = tempRoot(t);
  const outside = path.join(root, 'shared');
  fs.mkdirSync(outside);
  const stagingRoot = path.join(root, 'profile', 'data-lifecycle');
  fs.mkdirSync(path.dirname(stagingRoot), { recursive: true });
  fs.symlinkSync(outside, stagingRoot, 'junction');
  let produced = 0;
  const entry = { logicalPath: 'chats/session.json', category: 'chats', size: 9,
    produce() { produced += 1; return null; } };
  await assert.rejects(createArchive({ destinationRoot: path.join(root, 'archives'), entries: [entry],
    encrypted: true, passphrase: 'correct horse battery staple 42', stagingRoot }), { reason: 'unsafe_archive_path' });
  assert.equal(produced, 0, 'no plaintext may be produced through the redirect');
  assert.deepEqual(fs.readdirSync(outside), []);
});
