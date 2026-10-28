'use strict';

// The durable active-turn marker (services/backend/session-active-turn-marker.js)
// lets the startup active-turn seed read only the chats that may hold an active
// turn. Never missing a crash-orphaned turn is the contract; every fallback
// (missing, unreadable, unknown file, failed write) reads every chat again.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { SessionStorageBackend } = require('../services/backend/session-storage-backend');
const { MARKER_FILE_NAME } = require('../services/backend/session-active-turn-marker');
const { pruneLegacySessionFiles } = require('../services/backend/session-legacy-file-prune');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const TURN = {
  request_id: 'req_1',
  stream_id: 'stream_1',
  user_message_id: 'user_1',
  started_at: '2026-10-19T10:00:00.000Z',
  last_event_at: '2026-10-19T10:00:01.000Z',
  status: 'streaming',
};

function makeProfile() {
  return path.join(createTrackedTempDir('jenny-active-turn-marker-'), 'sessions.json');
}

function markerPath(storePath) {
  return path.join(path.dirname(storePath), 'sessions', MARKER_FILE_NAME);
}

function readMarker(storePath) {
  return JSON.parse(fs.readFileSync(markerPath(storePath), 'utf8'));
}

// Counts chat files the backend reads from disk.
function countDiskReads(store) {
  const reads = [];
  const backend = store._backend;
  const original = backend._readSessionFromDisk.bind(backend);
  backend._readSessionFromDisk = (sessionId) => {
    reads.push(sessionId);
    return original(sessionId);
  };
  return reads;
}

function seedChats(storePath, count) {
  const store = new ElectronSessionStore(storePath);
  for (let i = 0; i < count; i += 1) store.createSessionWithId(`sess_${i}`, { title: `Chat ${i}` });
  return store;
}

function activeIds(store) {
  return store.listSessionRecords().filter((record) => record.active_turn).map((record) => record.id).sort();
}

test('a crash-orphaned active turn is found at startup by reading only the marked chat', () => {
  const storePath = makeProfile();
  const first = seedChats(storePath, 5);
  // Startup seed with no marker: every chat is read once and the marker written.
  assert.deepEqual(activeIds(first), []);
  assert.deepEqual(readMarker(storePath).session_ids, []);
  first.setActiveTurn('sess_3', TURN);
  assert.deepEqual(readMarker(storePath).session_ids, ['sess_3'], 'marked before the turn is on disk');
  first.flush();
  // No dispose: the process crashed mid-turn.

  const restarted = new ElectronSessionStore(storePath);
  const reads = countDiskReads(restarted);
  assert.deepEqual(activeIds(restarted), ['sess_3']);
  assert.deepEqual(reads, ['sess_3'], 'only the marked chat is read');
  restarted.dispose();
  first.dispose();
});

test('the chat is marked before the write that puts its active turn on disk', () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 2);
  store.listSessionRecords();
  const backend = store._backend;
  const order = [];
  const persist = backend._activeTurnMarker._persist.bind(backend._activeTurnMarker);
  backend._activeTurnMarker._persist = () => {
    order.push('marker');
    persist();
  };
  const getStore = backend._getOrCreateSessionStore.bind(backend);
  backend._getOrCreateSessionStore = (sessionId) => {
    const sessionStore = getStore(sessionId);
    if (!sessionStore.__wrapped) {
      const write = sessionStore.write.bind(sessionStore);
      sessionStore.write = (value) => {
        if (value?.session?.active_turn) order.push('session');
        return write(value);
      };
      sessionStore.__wrapped = true;
    }
    return sessionStore;
  };
  store.setActiveTurn('sess_1', TURN);
  assert.deepEqual(order, ['marker', 'session']);
  store.dispose();
});

test('a cleared turn leaves the marker at the next rebuild, and the next start reads nothing', () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 3);
  store.listSessionRecords();
  store.setActiveTurn('sess_0', TURN);
  store.clearActiveTurn('sess_0', { request_id: 'req_1', stream_id: 'stream_1' });
  // Still listed until verified state rewrites it: the clear may not be on disk yet.
  assert.deepEqual(readMarker(storePath).session_ids, ['sess_0']);
  store.dispose();
  assert.deepEqual(readMarker(storePath).session_ids, []);

  const restarted = new ElectronSessionStore(storePath);
  const reads = countDiskReads(restarted);
  assert.deepEqual(activeIds(restarted), []);
  assert.deepEqual(reads, []);
  restarted.dispose();
});

test('a missing, damaged or unknown marker falls back to reading every chat once and rebuilds it', () => {
  for (const damage of [
    (file) => fs.rmSync(file),
    (file) => fs.writeFileSync(file, '{not json'),
    (file) => fs.writeFileSync(file, JSON.stringify({ version: 99, schema_version: 25, session_ids: [] })),
    (file) => fs.writeFileSync(file, JSON.stringify({ version: 1, schema_version: 24, session_ids: [] })),
    (file) => fs.writeFileSync(file, JSON.stringify({ version: 1, schema_version: 25, session_ids: [7] })),
  ]) {
    const storePath = makeProfile();
    const store = seedChats(storePath, 4);
    store.listSessionRecords();
    store.setActiveTurn('sess_2', TURN);
    store.flush();
    damage(markerPath(storePath));

    const restarted = new ElectronSessionStore(storePath);
    const reads = countDiskReads(restarted);
    assert.deepEqual(activeIds(restarted), ['sess_2']);
    assert.equal(reads.length, 4, 'every chat is read when the marker cannot be trusted');
    assert.deepEqual(readMarker(storePath).session_ids, ['sess_2']);
    restarted.dispose();
    store.dispose();
  }
});

test('before the startup seed an untrusted marker is never written, so a crash still reads every chat', () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 3);
  store.dispose();
  // An older build's profile: no marker at all.
  assert.equal(fs.existsSync(markerPath(storePath)), false);
  const second = new ElectronSessionStore(storePath);
  second.setActiveTurn('sess_1', TURN);
  second.flush();
  assert.equal(fs.existsSync(markerPath(storePath)), false, 'a marker holding only sess_1 would hide older turns');

  const third = new ElectronSessionStore(storePath);
  const reads = countDiskReads(third);
  assert.deepEqual(activeIds(third), ['sess_1']);
  assert.equal(reads.length, 3);
  third.dispose();
  second.dispose();
});

test('distrusting the marker removes its file, so a crash before the rebuild reads every chat', () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 3);
  store.listSessionRecords();
  store.dispose();
  assert.equal(fs.existsSync(markerPath(storePath)), true);

  const second = new ElectronSessionStore(storePath);
  second._backend._activeTurnMarker.distrust();
  assert.equal(fs.existsSync(markerPath(storePath)), false, 'a stale trusted file would hide a turn set before the rebuild');
  second.setActiveTurn('sess_2', TURN);
  second.flush();

  const third = new ElectronSessionStore(storePath);
  const reads = countDiskReads(third);
  assert.deepEqual(activeIds(third), ['sess_2']);
  assert.equal(reads.length, 3);
  third.dispose();
  second.dispose();
});

test('a failed marker write removes the marker so the next start reads every chat', () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 3);
  store.listSessionRecords();
  assert.equal(fs.existsSync(markerPath(storePath)), true);
  const marker = store._backend._activeTurnMarker;
  marker._writer = { writeImmediate() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  store.setActiveTurn('sess_0', TURN);
  store.flush();
  assert.equal(fs.existsSync(markerPath(storePath)), false);

  const restarted = new ElectronSessionStore(storePath);
  const reads = countDiskReads(restarted);
  assert.deepEqual(activeIds(restarted), ['sess_0']);
  assert.equal(reads.length, 3);
  restarted.dispose();
  store.dispose();
});

test('a marked chat whose file cannot be read stays marked', () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 2);
  store.listSessionRecords();
  store.setActiveTurn('sess_1', TURN);
  store.dispose();

  const restarted = new ElectronSessionStore(storePath);
  restarted._backend._readSessionFromDisk = () => null;
  assert.deepEqual(activeIds(restarted), []);
  restarted.dispose();
  assert.deepEqual(readMarker(storePath).session_ids, ['sess_1']);
});

test('a deleted chat drops out of the marker', () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 2);
  store.listSessionRecords();
  store.setActiveTurn('sess_0', TURN);
  store.deleteSession('sess_0');
  store.dispose();
  assert.deepEqual(readMarker(storePath).session_ids, []);
});

test('a backend without the option writes no marker (the shadow store)', () => {
  const rootDir = path.join(createTrackedTempDir('jenny-active-turn-marker-off-'), 'sessions');
  const backend = new SessionStorageBackend(rootDir, {
    schemaVersion: 25,
    migratePayload: (payload) => payload,
    normalizeSession: (id, record) => ({ ...record, id }),
    summarizeSession: (session) => ({ id: session.id }),
  });
  backend.upsertSession('sess_a', { active_turn: { request_id: 'r' } });
  assert.equal(backend.getActiveTurnSnapshots().size, 1);
  backend.dispose();
  assert.equal(fs.existsSync(path.join(rootDir, MARKER_FILE_NAME)), false);
});

test('an orphaned marker temp is pruned like a chat-file temp', async () => {
  const storePath = makeProfile();
  const store = seedChats(storePath, 1);
  store.listSessionRecords();
  store.dispose();
  const sessionsDir = path.join(path.dirname(storePath), 'sessions');
  const stamp = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const tmp = path.join(sessionsDir, `${MARKER_FILE_NAME}.${stamp}.0123456789ab.tmp`);
  fs.writeFileSync(tmp, '{}');
  const old = new Date(stamp);
  fs.utimesSync(tmp, old, old);
  const result = await pruneLegacySessionFiles({ legacyFilePath: storePath });
  assert.deepEqual(result.deleted.map((entry) => entry.file), [path.basename(tmp)]);
  assert.equal(fs.existsSync(markerPath(storePath)), true, 'the marker itself is never a prune candidate');
});
