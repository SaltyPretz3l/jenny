'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createSessionWriteMeter, notifyWriteMeasured } = require('../services/backend/session-write-meter');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackCloseable,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('takeTurn rolls up session writes and resets the session accumulator', () => {
  const meter = createSessionWriteMeter();
  meter.record({ kind: 'session', sessionId: 'a', bytes: 100, ms: 2.04, sync: true });
  meter.record({ kind: 'session', sessionId: 'a', bytes: 300, ms: 5.06, sync: true });
  meter.record({ kind: 'session', sessionId: 'a', bytes: 200, ms: 40, sync: false });
  const turn = meter.takeTurn('a');
  assert.equal(turn.session_bytes, 600);
  assert.equal(turn.session_writes, 3);
  assert.equal(turn.session_sync_writes, 2);
  assert.equal(turn.session_sync_ms, 7.1);
  assert.equal(turn.session_max_sync_ms, 5.1);
  assert.equal(turn.last_session_bytes, 200);
  assert.equal(turn.index_writes, 0);

  const again = meter.takeTurn('a');
  assert.equal(again.session_bytes, 0);
  assert.equal(again.session_writes, 0);
  assert.equal(again.last_session_bytes, 0);
});

test('sessions are accounted separately', () => {
  const meter = createSessionWriteMeter();
  meter.record({ kind: 'session', sessionId: 'a', bytes: 10, ms: 1, sync: true });
  meter.record({ kind: 'session', sessionId: 'b', bytes: 20, ms: 1, sync: true });
  assert.equal(meter.takeTurn('a').session_bytes, 10);
  assert.equal(meter.takeTurn('b').session_bytes, 20);
});

test('index writes are shared: a roll-up holds the index writes since the previous takeTurn of any session', () => {
  const meter = createSessionWriteMeter();
  meter.record({ kind: 'index', bytes: 50, ms: 1.5, sync: true });
  meter.record({ kind: 'index', bytes: 70, ms: 0.5, sync: false });
  const first = meter.takeTurn('a');
  assert.equal(first.index_bytes, 120);
  assert.equal(first.index_writes, 2);
  assert.equal(first.index_sync_writes, 1);
  assert.equal(first.index_sync_ms, 1.5);
  assert.equal(first.index_max_sync_ms, 1.5);
  assert.equal(first.session_writes, 0);

  meter.record({ kind: 'index', bytes: 5, ms: 1, sync: true });
  const second = meter.takeTurn('b');
  assert.equal(second.index_bytes, 5);
  assert.equal(second.index_writes, 1);
});

test('snapshot is cumulative and not reset by takeTurn', () => {
  const meter = createSessionWriteMeter();
  meter.record({ kind: 'session', sessionId: 'a', bytes: 100, ms: 3, sync: true });
  meter.record({ kind: 'index', bytes: 10, ms: 1, sync: true });
  meter.takeTurn('a');
  meter.record({ kind: 'session', sessionId: 'a', bytes: 50, ms: 4, sync: true });
  const snapshot = meter.snapshot();
  assert.equal(snapshot.session_bytes, 150);
  assert.equal(snapshot.session_writes, 2);
  assert.equal(snapshot.session_sync_ms, 7);
  assert.equal(snapshot.session_max_sync_ms, 4);
  assert.equal(snapshot.index_bytes, 10);
  assert.equal(snapshot.index_writes, 1);
  assert.equal('last_session_bytes' in snapshot, false);
});

test('invalid input is ignored', () => {
  const meter = createSessionWriteMeter();
  for (const input of [
    null,
    undefined,
    'text',
    {},
    { kind: 'other', sessionId: 'a', bytes: 1, ms: 1, sync: true },
    { kind: 'session', bytes: 1, ms: 1, sync: true },
    { kind: 'session', sessionId: '', bytes: 1, ms: 1, sync: true },
    { kind: 'session', sessionId: 'a', bytes: -1, ms: 1, sync: true },
    { kind: 'session', sessionId: 'a', bytes: Number.NaN, ms: 1, sync: true },
    { kind: 'session', sessionId: 'a', bytes: 1, ms: Number.POSITIVE_INFINITY, sync: true },
    { kind: 'index', bytes: '5', ms: 1, sync: true },
  ]) {
    meter.record(input);
  }
  const snapshot = meter.snapshot();
  assert.equal(snapshot.session_writes, 0);
  assert.equal(snapshot.index_writes, 0);
});

test('tracked sessions are capped and the oldest is evicted', () => {
  const meter = createSessionWriteMeter({ maxTrackedSessions: 3 });
  for (const id of ['a', 'b', 'c', 'd']) {
    meter.record({ kind: 'session', sessionId: id, bytes: 1, ms: 1, sync: true });
  }
  assert.equal(meter.takeTurn('a').session_writes, 0);
  assert.equal(meter.takeTurn('d').session_writes, 1);
  assert.equal(meter.snapshot().session_writes, 4);
});

test('notifyWriteMeasured reports payload bytes and swallows callback errors', () => {
  const seen = [];
  notifyWriteMeasured((info) => seen.push(info), 'héllo', performance.now(), performance.now(), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].bytes, Buffer.byteLength('héllo', 'utf8'));
  assert.equal(seen[0].sync, true);
  assert.doesNotThrow(() => notifyWriteMeasured(() => { throw new Error('boom'); }, 'x', 0, 0, false));
  assert.doesNotThrow(() => notifyWriteMeasured(null, 'x', 0, 0, false));
});

test('ElectronSessionStore logs one turn_write_volume roll-up after a flush', () => {
  const dir = createTrackedTempDir('jenny-write-meter-store-');
  const entries = [];
  const store = trackCloseable(new ElectronSessionStore(path.join(dir, 'sessions.json'), {
    writeDebounceMs: 60_000,
    logger: (level, event, details) => entries.push({ level, event, details }),
  }));
  const session = store.createSession({ title: 'Meter' });
  store.appendMessage(session.id, {
    id: 'msg_meter_1', role: 'user', content: 'hello', timestamp: '2026-07-14T10:00:00.000Z',
  });
  assert.equal(store.flushSession(session.id), true);

  const volume = store.logTurnWriteVolume(session.id);
  const logged = entries.filter((entry) => entry.event === 'session_store.turn_write_volume');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].level, 'INFO');
  assert.equal(logged[0].details.session_id, session.id);
  assert.ok(logged[0].details.session_bytes > 0);
  assert.ok(logged[0].details.session_sync_writes >= 1);
  assert.deepEqual(logged[0].details, { ...volume, session_id: session.id });

  assert.equal(store.logTurnWriteVolume(session.id), null, 'a second take finds nothing to report');
  assert.equal(
    entries.filter((entry) => entry.event === 'session_store.turn_write_volume').length,
    1
  );
  assert.ok(store._backend.getWriteVolumeSnapshot().session_bytes > 0);
});

test('logTurnWriteVolume never throws into the commit path', () => {
  const dir = createTrackedTempDir('jenny-write-meter-throw-');
  const store = trackCloseable(new ElectronSessionStore(path.join(dir, 'sessions.json'), {
    writeDebounceMs: 60_000,
    logger: () => { throw new Error('logger exploded'); },
  }));
  const session = store.createSession({ title: 'Meter' });
  store.flushSession(session.id);
  assert.doesNotThrow(() => store.logTurnWriteVolume(session.id));
  store._backend._writeMeter.takeTurn = () => { throw new Error('meter exploded'); };
  assert.equal(store.logTurnWriteVolume(session.id), null);
});
