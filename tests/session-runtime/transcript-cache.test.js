'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SessionStorageBackend } = require('../../services/backend/session-storage-backend');
const {
  finalizeCommit,
  hasDurableProof,
} = require('../../services/backend/conversation-store-port');
const {
  MAX_TRANSCRIPT_CACHE_BYTES,
  measureTranscriptBytes,
} = require('../../services/backend/session-transcript-cache');

function normalizeSession(id, record = {}) {
  return { id, title: record.title || id, messages: record.messages || [] };
}

function backend(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-transcript-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new SessionStorageBackend(root, {
    schemaVersion: 1,
    migratePayload: value => value,
    normalizeSession,
    summarizeSession: session => ({ id: session.id, title: session.title }),
    writeDebounceMs: 0,
  });
}

function record(id, bytes) {
  return normalizeSession(id, {
    messages: [{ role: 'assistant', content: 'x'.repeat(bytes) }],
  });
}

function seedCached(target, id, value) {
  target._cachedIndex.sessions[id] = { id, title: id };
  target._loadedSessions.set(id, value);
  target._sessionLru.add(id);
}

test('exact accounting matches JSON UTF-8 escaping without serializing a transcript copy', () => {
  const value = {
    ascii: 'plain', escaped: 'quote:" slash:\\ line:\n', unicode: 'Ω😀',
    controls: '\u0000\b\t', omitted: undefined, array: [undefined, -0, Infinity],
  };
  assert.equal(measureTranscriptBytes(value), Buffer.byteLength(JSON.stringify(value)));
});

test('clean LRU records are evicted to the 64 MiB byte ceiling', (t) => {
  const target = backend(t);
  const chunk = 24 * 1024 * 1024;
  seedCached(target, 'first', record('first', chunk));
  seedCached(target, 'second', record('second', chunk));
  seedCached(target, 'third', record('third', chunk));

  target._pruneCache();

  assert.equal(target._loadedSessions.has('first'), false);
  assert.equal(target._loadedSessions.has('second'), true);
  assert.equal(target._loadedSessions.has('third'), true);
  const pressure = target.getCachePressure();
  assert.ok(pressure.loadedBytes <= MAX_TRANSCRIPT_CACHE_BYTES);
  assert.equal(pressure.backpressured, false);
});

test('accepted same-identity mutation invalidates bytes until durable and then remeasures', (t) => {
  const target = backend(t);
  const session = record('dirty', 16);
  assert.equal(target.upsertSession('dirty', session, { alreadyNormalized: true }), true);
  const before = target.getCachePressure().loadedBytes;
  session.messages[0].content = 'changed in place'.repeat(100);

  assert.equal(target.upsertSession('dirty', session, {
    persist: false, alreadyNormalized: true,
  }), true);
  const dirty = target.getCachePressure();
  assert.equal(dirty.loadedBytes, null);
  assert.equal(dirty.unknownSessions, 1);
  assert.equal(dirty.backpressured, true);

  assert.equal(target.flushSession('dirty'), true);
  const durable = target.getCachePressure();
  assert.ok(durable.loadedBytes > before);
  assert.equal(durable.unknownSessions, 0);
  assert.equal(durable.backpressured, false);

  const restored = record('dirty', 4_000);
  assert.equal(target.restoreSessionSnapshot('dirty', restored, null), true);
  assert.equal(target.getCachePressure().loadedBytes,
    measureTranscriptBytes(target._loadedSessions.get('dirty')));
});

test('an oversized clean cache hit returns its record even when it self-evicts', (t) => {
  const target = backend(t);
  const oversized = record('oversized', MAX_TRANSCRIPT_CACHE_BYTES + 1);
  seedCached(target, 'oversized', oversized);

  const loaded = target.getSession('oversized');

  assert.equal(loaded, oversized);
  assert.equal(target._loadedSessions.has('oversized'), false);
  assert.equal(target.getCachePressure().loadedBytes, 0);

  const readonly = backend(t);
  seedCached(readonly, 'oversized', oversized);
  for (let index = 0; index < 31; index += 1) {
    seedCached(readonly, `future_${index}`, record(`future_${index}`, 1));
  }
  readonly._mode = 'monolithic_readonly';
  assert.equal(readonly.getSession('oversized'), oversized);
  assert.equal(readonly._loadedSessions.has('oversized'), true);
  assert.equal(readonly._loadedSessions.size, 32);
  assert.equal(readonly.getCachePressure().backpressured, true);
});

test('clean self-eviction retains bounded durability proof for finalizeCommit', (t) => {
  const target = backend(t);
  target._transcriptCache.limitBytes = 128;
  const oversized = record('commit', 1_024);

  assert.equal(target.upsertSession('commit', oversized, { alreadyNormalized: true }), true);
  assert.equal(target._loadedSessions.has('commit'), false);
  const result = finalizeCommit({
    _backend: target,
    flushSession: sessionId => target.flushSession(sessionId),
  }, 'commit', { accepted: true, applied: true, durableRequested: true });

  assert.equal(hasDurableProof(result), true);
  assert.ok(result.commitEpoch > 0);

  assert.equal(target.getSession('commit').messages[0].content, oversized.messages[0].content);
  assert.equal(target._loadedSessions.has('commit'), false);
  const changed = record('commit', 2_048);
  assert.equal(target.upsertSession('commit', changed, { alreadyNormalized: true }), true);
  const changedResult = finalizeCommit({
    _backend: target,
    flushSession: sessionId => target.flushSession(sessionId),
  }, 'commit', { accepted: true, applied: true, durableRequested: true });
  assert.equal(hasDurableProof(changedResult), true);
  assert.ok(changedResult.commitEpoch > result.commitEpoch);

  assert.equal(target.deleteSession('commit'), true);
  assert.equal(target.getSessionDurability('commit'), null);
});

test('finalizeCommit flushes a deferred oversized mutation before self-eviction', (t) => {
  const target = backend(t);
  target._transcriptCache.limitBytes = 128;
  const oversized = record('deferred', 1_024);

  assert.equal(target.upsertSession('deferred', oversized, {
    persist: false,
    alreadyNormalized: true,
  }), true);
  assert.equal(target._loadedSessions.has('deferred'), true);
  assert.equal(target.getCachePressure().backpressured, true);

  const result = finalizeCommit({
    _backend: target,
    flushSession: sessionId => target.flushSession(sessionId),
  }, 'deferred', { accepted: true, applied: true, durableRequested: true });

  assert.equal(hasDurableProof(result), true);
  assert.equal(target._loadedSessions.has('deferred'), false);
  assert.deepEqual(target.getSessionDurability('deferred'), {
    dirtyEpoch: result.commitEpoch,
    durableEpoch: result.durableEpoch,
  });
});

test('clean durability proofs remain bounded across repeated self-eviction', (t) => {
  const target = backend(t);
  target._transcriptCache.limitBytes = 128;

  for (let index = 0; index < 35; index += 1) {
    const sessionId = `bounded_${index}`;
    assert.equal(target.upsertSession(sessionId, record(sessionId, 1_024), {
      alreadyNormalized: true,
    }), true);
    assert.equal(target._loadedSessions.has(sessionId), false);
  }

  assert.equal(target._durability._evictedProofs.size, 30);
  assert.equal(target.getSessionDurability('bounded_0'), null);
  assert.notEqual(target.getSessionDurability('bounded_34'), null);
});

test('failed snapshot restore remains dirty, cached, and backpressured', (t) => {
  const target = backend(t);
  assert.equal(target.upsertSession('restore', record('restore', 8), {
    alreadyNormalized: true,
  }), true);
  target._transcriptCache.limitBytes = 128;
  const failedStore = {
    filePath: path.join(target._rootDir, 'restore.json'),
    writeImmediate() { throw new Error('restore write failed'); },
    hasPendingWrite() { return false; },
    getWriteState() { return { durableGeneration: 1 }; },
  };
  target._sessionStores.set('restore', failedStore);

  assert.equal(target.restoreSessionSnapshot('restore', record('restore', 1_024), null), false);
  assert.equal(target._loadedSessions.has('restore'), true);
  assert.equal(target.hasPendingWriteForSession('restore'), true);
  const pressure = target.getCachePressure();
  assert.equal(pressure.loadedBytes, null);
  assert.equal(pressure.backpressured, true);
});
