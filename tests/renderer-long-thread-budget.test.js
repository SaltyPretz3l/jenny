'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUDGETS,
  collectPinnedTurnIds,
  isLongThreadBoundsEnabled,
  pruneMapOldestFirst,
  touchMapEntry,
} = require('../renderer/chat/renderer-render-pipeline-projection-cache');

test('R2 budget defaults are finite and the rollback flag is explicit', () => {
  assert.deepEqual(BUDGETS, {
    projectionCacheSessions: 16,
    projectedTurns: 192,
    diagnosticKeys: 256,
    rootMarkupEntries: 128,
    virtualizedMarkupEntries: 160,
    statefulDetachedEntries: 24,
    targetMaterializedArticles: 160,
    observers: 3,
    scheduledLayoutTasks: 1,
  });
  for (const value of Object.values(BUDGETS)) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.ok(value > 0);
  }
  assert.equal(isLongThreadBoundsEnabled({ chat_long_thread_bounds: true }), true);
  assert.equal(isLongThreadBoundsEnabled({ chat_long_thread_bounds: false }), false);
  assert.equal(isLongThreadBoundsEnabled({}), true);
});

test('R2 oldest-first eviction preserves pinned entries deterministically', () => {
  const cache = new Map(Array.from({ length: 8 }, (_unused, index) => [`turn-${index}`, index]));
  const result = pruneMapOldestFirst(cache, 4, {
    isPinned(key) { return key === 'turn-0' || key === 'turn-3'; },
  });
  assert.deepEqual(result.evicted, ['turn-1', 'turn-2', 'turn-4', 'turn-5']);
  assert.deepEqual(Array.from(cache.keys()), ['turn-0', 'turn-3', 'turn-6', 'turn-7']);
});

test('R2 cache touch moves a reused turn behind older entries', () => {
  const cache = new Map([['a', 1], ['b', 2], ['c', 3]]);
  assert.equal(touchMapEntry(cache, 'a'), true);
  assert.deepEqual(Array.from(cache.keys()), ['b', 'c', 'a']);
});

test('R2 active/newest and approval turns are pinned', () => {
  const turns = [{ turn_id: 'old' }, { turn_id: 'approval' }, { turn_id: 'active' }];
  const rows = new Map([
    ['old', [{ kind: 'assistant_text', payload: { state: 'completed' } }]],
    ['approval', [{ kind: 'approval_gap', payload: { state: 'pending_approval' } }]],
    ['active', [{ kind: 'assistant_text', payload: { state: 'streaming' } }]],
  ]);
  assert.deepEqual(Array.from(collectPinnedTurnIds(turns, rows)).sort(), ['active', 'approval']);
});
