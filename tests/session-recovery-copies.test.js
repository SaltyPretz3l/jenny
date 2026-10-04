'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { purgeSessionRecoveryCopies } = require('../services/backend/session-recovery-copies');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const PRIVATE_TEXT = 'private-synthetic-transcript-4f9c1a';
const DAMAGED_BYTES = '{"schema_version": 22, "session": {"id": "x", "messages": [';

function setup(t, prefix = 'jenny-recovery-copies-') {
  const userDataPath = createTrackedTempDir(prefix);
  const storePath = path.join(userDataPath, 'sessions.json');
  const entries = [];
  const logger = (level, event, details = {}) => entries.push({ level, event, details });
  const stores = [];
  const open = () => {
    const store = new ElectronSessionStore(storePath, { logger });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) {
      try { store.dispose(); } catch (_error) { void _error; }
    }
  });
  return { userDataPath, storePath, sessionsDir: path.join(userDataPath, 'sessions'), entries, open };
}

function listFilesRecursive(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function addMessage(store, sessionId, content) {
  store.appendMessage(sessionId, { id: `msg_${sessionId}`, role: 'user', content });
}

test('a damaged legacy sessions.json is preserved beside the profile and logged, not hidden', (t) => {
  const { userDataPath, storePath, entries, open } = setup(t);
  fs.writeFileSync(storePath, DAMAGED_BYTES);

  const store = open();

  assert.deepEqual(store.listSessions(), []);
  const preserved = fs.readdirSync(userDataPath).filter((name) => /^sessions\.json\.corrupt-\d+$/.test(name));
  assert.equal(preserved.length, 1, 'the damaged original is kept under a .corrupt-<ms> name');
  assert.equal(fs.readFileSync(path.join(userDataPath, preserved[0]), 'utf8'), DAMAGED_BYTES);
  assert.equal(fs.existsSync(storePath), false);
  const logged = entries.filter((entry) => entry.event === 'session_store.legacy_file_corrupt');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].level, 'ERROR');
  assert.equal(JSON.stringify(logged[0].details).includes('schema_version'), false, 'no file contents in the log');
});

test('a parseable legacy sessions.json still migrates as before', (t) => {
  const { userDataPath, storePath, entries, open } = setup(t);
  fs.writeFileSync(storePath, JSON.stringify({ schema_version: 1, sessions: {} }));

  const store = open();

  assert.deepEqual(store.listSessions(), []);
  assert.deepEqual(fs.readdirSync(userDataPath).filter((name) => name.includes('.corrupt-')), []);
  assert.equal(entries.some((entry) => entry.event === 'session_store.legacy_file_corrupt'), false);
});

function failLegacyReads(t, storePath, failures) {
  const original = fs.readFileSync;
  let remaining = failures;
  fs.readFileSync = function readFileSync(target, ...rest) {
    if (target === storePath && remaining > 0) {
      remaining -= 1;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return original.call(this, target, ...rest);
  };
  const restore = () => { fs.readFileSync = original; };
  t.after(restore);
  return restore;
}

const LEGACY_PAYLOAD = JSON.stringify({
  schema_version: 1,
  sessions: { sess_legacy: { id: 'sess_legacy', title: 'Legacy chat', messages: [] } },
});

test('a legacy sessions.json that is briefly busy still migrates', (t) => {
  const { userDataPath, storePath, open } = setup(t);
  fs.writeFileSync(storePath, LEGACY_PAYLOAD);
  failLegacyReads(t, storePath, 1);

  const store = open();

  assert.deepEqual(store.listSessions().map((session) => session.id), ['sess_legacy']);
  assert.deepEqual(fs.readdirSync(userDataPath).filter((name) => name.includes('.corrupt-')), []);
});

test('a legacy sessions.json that cannot be read is left in place and migrates on the next start', (t) => {
  const { userDataPath, storePath, sessionsDir, entries, open } = setup(t);
  fs.writeFileSync(storePath, LEGACY_PAYLOAD);
  const restore = failLegacyReads(t, storePath, Number.POSITIVE_INFINITY);

  const blocked = open();

  assert.deepEqual(blocked.listSessions(), []);
  assert.deepEqual(fs.readdirSync(userDataPath).filter((name) => name.includes('.corrupt-')), []);
  assert.equal(fs.existsSync(path.join(sessionsDir, '_index.json')), false, 'no split index hides the legacy file');
  const logged = entries.filter((entry) => entry.event === 'session_store.legacy_file_unreadable');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].details.errorCode, 'EBUSY');
  blocked.dispose();
  restore();

  assert.equal(fs.readFileSync(storePath, 'utf8'), LEGACY_PAYLOAD);
  assert.deepEqual(open().listSessions().map((session) => session.id), ['sess_legacy']);
});

test('an index rebuild keeps a damaged chat listed and quarantines its bytes on first read', (t) => {
  const { sessionsDir, open } = setup(t);
  const first = open();
  const ids = [
    first.createSession({ title: 'One' }).id,
    first.createSession({ title: 'Two' }).id,
    first.createSession({ title: 'Three' }).id,
  ];
  for (const id of ids) addMessage(first, id, `body ${id}`);
  first.flush();
  first.dispose();
  fs.rmSync(path.join(sessionsDir, '_index.json'));
  const damagedId = ids[1];
  const damagedPath = path.join(sessionsDir, `${damagedId}.json`);
  fs.writeFileSync(damagedPath, DAMAGED_BYTES);

  const second = open();

  assert.deepEqual(second.getSessionIds().sort(), [...ids].sort());
  const stub = second.getSession(damagedId);
  assert.ok(stub, 'the damaged chat is readable as an empty stub');
  assert.deepEqual(stub.messages, []);
  const quarantined = fs.readdirSync(path.join(sessionsDir, 'corrupt'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(sessionsDir, 'corrupt', quarantined[0]), 'utf8'), DAMAGED_BYTES);
  assert.equal(second.getSession(ids[0]).messages.length, 1);
});

test('an index rebuild in which every chat file is damaged still lists them all', (t) => {
  const { sessionsDir, open } = setup(t);
  const first = open();
  const ids = [first.createSession({ title: 'A' }).id, first.createSession({ title: 'B' }).id];
  first.flush();
  first.dispose();
  fs.rmSync(path.join(sessionsDir, '_index.json'));
  for (const id of ids) fs.writeFileSync(path.join(sessionsDir, `${id}.json`), DAMAGED_BYTES);

  const second = open();

  assert.deepEqual(second.getSessionIds().sort(), [...ids].sort());
  assert.ok(fs.existsSync(path.join(sessionsDir, '_index.json')), 'the rebuilt index is written');
});

test('deleting a chat removes its quarantined original too', (t) => {
  const { sessionsDir, open } = setup(t);
  const first = open();
  const { id } = first.createSession({ title: 'Private' });
  addMessage(first, id, PRIVATE_TEXT);
  first.flush();
  first.dispose();
  const filePath = path.join(sessionsDir, `${id}.json`);
  const original = fs.readFileSync(filePath, 'utf8');
  assert.ok(original.includes(PRIVATE_TEXT));
  fs.writeFileSync(filePath, `${original}\u0000not json`);

  const second = open();
  assert.deepEqual(second.getSession(id).messages, []);
  const quarantineDir = path.join(sessionsDir, 'corrupt');
  assert.ok(fs.readdirSync(quarantineDir).some((name) => name.startsWith(`${id}.`)));

  assert.equal(second.deleteSession(id), true);
  second.flush();

  const leftovers = listFilesRecursive(sessionsDir)
    .filter((file) => fs.readFileSync(file, 'utf8').includes(PRIVATE_TEXT));
  assert.deepEqual(leftovers, []);
});

test('deleting a chat removes its own interrupted-write temp and leaves other chats alone', (t) => {
  const { sessionsDir, open } = setup(t);
  const store = open();
  const mine = store.createSession({ title: 'Mine' }).id;
  const other = store.createSession({ title: 'Other' }).id;
  store.flush();
  const tempName = (id, stamp = Date.now(), hex = 'a1b2c3d4e5f6') => `${id}.json.${stamp}.${hex}.tmp`;
  const mineTemp = path.join(sessionsDir, tempName(mine));
  const otherTemp = path.join(sessionsDir, tempName(other));
  fs.writeFileSync(mineTemp, PRIVATE_TEXT);
  fs.writeFileSync(otherTemp, 'other chat temp');

  assert.equal(store.deleteSession(mine), true);

  assert.equal(fs.existsSync(mineTemp), false);
  assert.equal(fs.readFileSync(otherTemp, 'utf8'), 'other chat temp');
  assert.equal(store.getSession(other).id, other);
});

test('purgeSessionRecoveryCopies matches only this chat, regular files, direct children', (t) => {
  const { sessionsDir, open } = setup(t);
  const store = open();
  const id = store.createSession({ title: 'Target' }).id;
  store.flush();
  const quarantineDir = path.join(sessionsDir, 'corrupt');
  fs.mkdirSync(quarantineDir, { recursive: true });
  const stamp = Date.now();
  const purged = [
    path.join(quarantineDir, `${id}.${stamp}.json`),
    path.join(quarantineDir, `${id}.${stamp + 1}.json`),
    path.join(sessionsDir, `${id}.json.${stamp}.0123456789ab.tmp`),
  ];
  const kept = [
    path.join(sessionsDir, `${id}.json`),
    path.join(sessionsDir, '_index.json'),
    path.join(quarantineDir, `${id}x.${stamp}.json`),
    path.join(quarantineDir, `x${id}.${stamp}.json`),
    path.join(quarantineDir, `${id}.${stamp}.json.bak`),
    path.join(sessionsDir, `${id}.json.${stamp + 5}.0123456789AB.tmp`),
    path.join(sessionsDir, `${id}.json.${stamp}.0123456789a.tmp`),
    path.join(sessionsDir, `${id}x.json.${stamp}.0123456789ab.tmp`),
  ];
  for (const file of [...purged, ...kept.slice(2)]) fs.writeFileSync(file, 'x');
  const nestedDir = path.join(quarantineDir, `${id}.${stamp + 2}.json`);
  fs.mkdirSync(nestedDir);
  fs.writeFileSync(path.join(nestedDir, 'inner.json'), 'x');

  const result = purgeSessionRecoveryCopies(store._backend, id);

  assert.deepEqual(result, { removed: 3, failed: 0 });
  for (const file of purged) assert.equal(fs.existsSync(file), false, path.basename(file));
  for (const file of kept) assert.equal(fs.existsSync(file), true, path.basename(file));
  assert.equal(fs.existsSync(path.join(nestedDir, 'inner.json')), true, 'directories are never entered');
  assert.deepEqual(store.purgeSessionRecoveryCopies(id), { removed: 0, failed: 0 });
});

test('purgeSessionRecoveryCopies reports a denied unlink without throwing', (t) => {
  const { sessionsDir, entries, open } = setup(t);
  const store = open();
  const id = store.createSession({ title: 'Locked' }).id;
  store.flush();
  const denied = path.join(sessionsDir, `${id}.json.${Date.now()}.0123456789ab.tmp`);
  const allowed = path.join(sessionsDir, `${id}.json.${Date.now() + 1}.fedcba987654.tmp`);
  fs.writeFileSync(denied, PRIVATE_TEXT);
  fs.writeFileSync(allowed, 'x');
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(denied)) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return realUnlink.call(fs, target, ...rest);
  };
  t.after(() => { fs.unlinkSync = realUnlink; });

  assert.deepEqual(purgeSessionRecoveryCopies(store._backend, id), { removed: 1, failed: 1 });
  assert.equal(fs.existsSync(allowed), false);
  assert.equal(fs.existsSync(denied), true);

  assert.equal(store.deleteSession(id), true, 'a failed purge does not change the delete result');
  const warned = entries.filter((entry) => entry.event === 'session_store.recovery_copy_delete_failed');
  assert.equal(warned.length, 1);
  assert.equal(warned[0].level, 'WARN');
  assert.equal(warned[0].details.sessionId, id);
  assert.equal(warned[0].details.failed, 1);
});

test('an index rebuild does not list a damaged file whose name is not a chat id', (t) => {
  const { sessionsDir, open } = setup(t);
  const first = open();
  const keptId = first.createSession({ title: 'Kept' }).id;
  first.flush();
  first.dispose();
  fs.rmSync(path.join(sessionsDir, '_index.json'));
  const hashedName = `~${'a'.repeat(64)}.json`;
  fs.writeFileSync(path.join(sessionsDir, hashedName), DAMAGED_BYTES);

  const second = open();

  assert.deepEqual(second.getSessionIds(), [keptId]);
  assert.equal(fs.readFileSync(path.join(sessionsDir, hashedName), 'utf8'), DAMAGED_BYTES, 'the bytes are left in place');
});
