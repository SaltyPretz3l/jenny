'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUDGETS,
  collectPinnedTurnIds,
  createProjectionCachePipeline,
  pruneMapOldestFirst,
  touchMapEntry,
} = require('../renderer/chat/renderer-render-pipeline-projection-cache');
const { createHydrationPipeline } = require('../renderer/chat/renderer-render-pipeline-hydration');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
const {
  buildMessageProjectionFingerprint,
  computeMessageFingerprintList,
} = require('../renderer/chat/renderer-message-index-utils');
const { indexRowsByRenderMessageId } = require('../renderer/chat/renderer-render-message-index-utils');

// Bounds are unconditional: neither a missing flag nor a flag set false (every
// key reads false here) may turn the caps off.
const FLAG_STATES = [
  ['no flag in state', () => ({})],
  ['every flag false', () => new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? false : undefined) })],
];

test('R2 budget defaults are finite', () => {
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

for (const [label, makeFlags] of FLAG_STATES) {
  test(`R2 the projected-turn cache is pruned to its budget (${label})`, () => {
    const state = { features: { featureFlags: makeFlags() }, pendingStreams: new Map(), ui: {} };
    const hydration = createHydrationPipeline({
      state,
      callbacks: {
        projectTurnTree,
        projectTurn,
        projectTurnRows: (events, options) => projectTurn({ turn_id: '', events }, options).rows,
        buildMessageProjectionFingerprint,
        indexRowsByRenderMessageId,
      },
    });
    const turnCount = BUDGETS.projectedTurns + 20;
    const messages = [];
    for (let index = 0; index < turnCount; index += 1) {
      const streamId = `budget_stream_${index}`;
      messages.push({ id: `budget_user_${index}`, role: 'user', content: `Prompt ${index}`, streamId });
      messages.push({ id: `budget_assistant_${index}`, role: 'assistant', status: 'complete', streamId, content: `Answer ${index}` });
    }
    const fingerprints = computeMessageFingerprintList(messages);
    const cache = new Map();
    const projection = hydration.buildHydratedTurnProjection(
      messages,
      null,
      { turnEventLogVersion: 0, turnEvents: [] },
      {
        turnRowCache: cache,
        messageContentFingerprintById: new Map(messages.map((message, index) => [message.id, fingerprints[index].content])),
        sessionId: 'budget-session',
      }
    );
    assert.equal(projection.rowsByTurnId.size, turnCount, 'the projection itself keeps every turn');
    assert.equal(cache.size, BUDGETS.projectedTurns);
  });

  test(`R2 tool-row diagnostic key sets are pruned to their budget (${label})`, () => {
    const uiRuntime = {
      projectionContextBySession: new Map(),
      toolRowProjectionFallbacksBySession: new Map(),
      toolRowProjectionFailuresBySession: new Map(),
    };
    const state = {
      currentSessionId: 'budget-diagnostics',
      features: { featureFlags: makeFlags() },
      ui: { chatTimelineRowModelMetaBySession: new Map() },
    };
    const pipeline = createProjectionCachePipeline({ state, dom: {}, runtime: { uiRuntime }, callbacks: {} });
    const overflow = BUDGETS.diagnosticKeys + 10;
    for (let index = 0; index < overflow; index += 1) {
      pipeline.logToolRowProjectionFallbackOnce(`msg-${index}`, 'missing_projected_row');
      pipeline.logToolRowProjectionFailureOnce(`reason-${index}`);
    }
    assert.equal(uiRuntime.toolRowProjectionFallbacksBySession.get('budget-diagnostics').size, BUDGETS.diagnosticKeys);
    assert.equal(uiRuntime.toolRowProjectionFailuresBySession.get('budget-diagnostics').size, BUDGETS.diagnosticKeys);
  });
}
