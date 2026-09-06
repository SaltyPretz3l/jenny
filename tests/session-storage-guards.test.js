'use strict';

// Direct unit tests for the extracted backend guards
// (services/backend/session-storage-guards.js). Static-literal import so the
// coverage-map graph reaches the source; the reconcile path is additionally
// exercised end-to-end through SessionStorageBackend.flush()/flushAsync().
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DIRTY_FLUSH_FAILURE_CAP,
  reconcileDirtyAfterFlush,
  readsNewerSchema,
  enterNewerSchemaFreeze,
  freezeRecoveredIndex,
} = require('../services/backend/session-storage-guards');

function makeSelf() {
  const logs = [];
  return {
    _dirtySessionIds: new Set(),
    _dirtyFlushFailureCounts: new Map(),
    _logger: (level, event, data) => logs.push({ level, event, data }),
    _storeName: 'guard_store',
    _logs: logs,
  };
}

test('DIRTY_FLUSH_FAILURE_CAP is a small positive integer', () => {
  assert.ok(Number.isInteger(DIRTY_FLUSH_FAILURE_CAP) && DIRTY_FLUSH_FAILURE_CAP >= 1);
});

test('reconcileDirtyAfterFlush clears flushed ids and resets their failure counters', () => {
  const self = makeSelf();
  self._dirtySessionIds.add('a').add('b');
  self._dirtyFlushFailureCounts.set('a', 2);
  reconcileDirtyAfterFlush(self, ['a', 'b'], []);
  assert.equal(self._dirtySessionIds.has('a'), false);
  assert.equal(self._dirtySessionIds.has('b'), false);
  assert.equal(self._dirtyFlushFailureCounts.has('a'), false, 'a cleared flush resets the failure counter');
});

test('reconcileDirtyAfterFlush retains a failed id below the cap and increments its counter', () => {
  const self = makeSelf();
  self._dirtySessionIds.add('x');
  reconcileDirtyAfterFlush(self, [], ['x']);
  assert.equal(self._dirtySessionIds.has('x'), true, 'a below-cap failure retains the dirty id');
  assert.equal(self._dirtyFlushFailureCounts.get('x'), 1);
  assert.equal(
    self._logs.filter((l) => l.event.endsWith('flush_dirty_retained_after_retries')).length,
    0,
    'no drop ERROR below the cap'
  );
});

test('reconcileDirtyAfterFlush retains a failed id at the cap with one ERROR', () => {
  const self = makeSelf();
  self._dirtySessionIds.add('x');
  for (let i = 0; i < DIRTY_FLUSH_FAILURE_CAP; i += 1) {
    reconcileDirtyAfterFlush(self, [], ['x']);
  }
  assert.equal(self._dirtySessionIds.has('x'), true, 'accepted state remains dirty at the cap');
  assert.equal(self._dirtyFlushFailureCounts.get('x'), DIRTY_FLUSH_FAILURE_CAP);
  const retained = self._logs.filter((l) => l.event === 'guard_store.flush_dirty_retained_after_retries');
  assert.equal(retained.length, 1, 'exactly one retention ERROR');
  assert.equal(retained[0].level, 'ERROR');
  assert.equal(retained[0].data.attempts, DIRTY_FLUSH_FAILURE_CAP);
});

test('reconcileDirtyAfterFlush resets the failure streak when a previously-failing id succeeds', () => {
  const self = makeSelf();
  self._dirtySessionIds.add('x');
  reconcileDirtyAfterFlush(self, [], ['x']); // fail once -> count 1
  reconcileDirtyAfterFlush(self, ['x'], []); // then succeed -> cleared
  assert.equal(self._dirtySessionIds.has('x'), false);
  assert.equal(self._dirtyFlushFailureCounts.has('x'), false, 'a success resets the streak');
});

test('readsNewerSchema flags a future envelope and ignores current / bare / non-object payloads', () => {
  const self = { _schemaVersion: 3 };
  assert.equal(readsNewerSchema(self, { schema_version: 4, session: {} }), true, 'a higher version is newer');
  assert.equal(readsNewerSchema(self, { schema_version: 3, session: {} }), false, 'equal is not newer');
  assert.equal(readsNewerSchema(self, { schema_version: 2, session: {} }), false, 'older is not newer');
  assert.equal(readsNewerSchema(self, { id: 'bare' }), false, 'a bare record has no numeric schema_version');
  assert.equal(readsNewerSchema(self, null), false, 'null is not newer');
  assert.equal(readsNewerSchema(self, [1, 2]), false, 'an array is not a session envelope');
});

test('enterNewerSchemaFreeze records the highest observed version and emits a per-file diagnostic', () => {
  const logs = [];
  const self = {
    _schemaVersion: 3,
    _newerSchemaVersion: 0,
    _storeName: 'g',
    _logger: (level, event, data) => logs.push({ level, event, data }),
  };
  enterNewerSchemaFreeze(self, 5, '/x/sess.json');
  assert.equal(self._newerSchemaVersion, 5);
  enterNewerSchemaFreeze(self, 4, '/x/other.json'); // a lower observed must not lower the freeze
  assert.equal(self._newerSchemaVersion, 5, 'the highest observed version wins');
  const detected = logs.filter((x) => x.event === 'g.newer_schema_detected');
  assert.equal(detected.length, 2, 'each future file emits a diagnostic');
  assert.equal(detected[0].data.observedVersion, 5);
  assert.equal(detected[0].data.filePath, '/x/sess.json', 'keyed by the session file path');
});

test('freezeRecoveredIndex drops partial recovered state and presents an empty index', () => {
  const self = {
    _schemaVersion: 3,
    _loadedSessions: new Map([['a', {}]]),
    _scanActiveTurns: new Map([['a', null]]),
    _cachedIndex: { schema_version: 3, sessions: { a: {} } },
  };
  freezeRecoveredIndex(self);
  assert.equal(self._loadedSessions.size, 0, 'loaded sessions are dropped');
  assert.equal(self._scanActiveTurns.size, 0, 'the active-turn scan is dropped');
  assert.deepEqual(self._cachedIndex, { schema_version: 3, sessions: {} }, 'an empty index is presented');
});
