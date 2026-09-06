'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
const {
  buildMessageProjectionFingerprint,
  computeMessageFingerprintList,
} = require('../renderer/chat/renderer-message-index-utils');
const { createHydrationPipeline } = require('../renderer/chat/renderer-render-pipeline-hydration');
const { indexRowsByRenderMessageId } = require('../renderer/chat/renderer-render-message-index-utils');
const { BUDGETS } = require('../renderer/chat/renderer-render-pipeline-projection-cache');

const PERF_BUDGET_MS = 500;

function buildCorpus(turnCount, mode) {
  const messages = [];
  for (let index = 0; index < turnCount; index += 1) {
    const streamId = `r2_stream_${index}`;
    messages.push({ id: `r2_user_${index}`, role: 'user', content: `Prompt ${index}`, streamId });
    if (mode === 'tool' || mode === 'mermaid') {
      messages.push({
        id: `r2_tool_call_${index}`,
        role: 'assistant',
        kind: 'tool_use',
        streamId,
        tool_call: { call_id: `r2_call_${index}`, name: 'workspace_read', status: 'completed' },
      });
      messages.push({
        id: `r2_tool_result_${index}`,
        role: 'tool',
        kind: 'tool_result',
        streamId,
        tool_result: {
          call_id: `r2_call_${index}`,
          status: 'completed',
          output_text: mode === 'mermaid' ? '```mermaid\ngraph TD; A-->B\n```' : `result ${index}`,
        },
      });
    }
    messages.push({
      id: `r2_assistant_${index}`,
      role: 'assistant',
      status: index === turnCount - 1 && mode === 'streaming' ? 'streaming' : 'complete',
      streamId,
      content: `Answer ${index} ${'x'.repeat(200)}`,
      phases: mode === 'reasoning'
        ? [{ id: `r2_phase_${index}`, kind: 'reasoning', status: 'complete', entries: [{ id: `r2_entry_${index}`, text: 'reason '.repeat(40) }] }]
        : [],
    });
  }
  return messages;
}

function projectCorpus(messages) {
  const startedAt = performance.now();
  const tree = projectTurnTree({ messages });
  let rowCount = 0;
  for (const turn of tree.turns) rowCount += projectTurn(turn, { deterministicRowId: true }).rows.length;
  computeMessageFingerprintList(messages);
  return { elapsedMs: performance.now() - startedAt, rowCount, turnCount: tree.turns.length };
}

for (const [name, turns, mode] of [
  ['short', 12, 'text'],
  ['100+ tool-heavy', 120, 'tool'],
  ['100+ reasoning-heavy', 120, 'reasoning'],
  ['100+ Mermaid tool results', 120, 'mermaid'],
]) {
  test(`R2 projection corpus: ${name}`, () => {
    const result = projectCorpus(buildCorpus(turns, mode));
    assert.equal(result.turnCount, turns);
    assert.ok(result.rowCount >= turns);
    assert.ok(result.elapsedMs < PERF_BUDGET_MS, `${name} projection took ${result.elapsedMs.toFixed(1)}ms`);
  });
}

test('R2 long streaming tail stays within the focused projection budget', () => {
  let messages = buildCorpus(120, 'streaming');
  const startedAt = performance.now();
  for (let index = 0; index < 100; index += 1) {
    const tail = messages[messages.length - 1];
    messages = messages.slice(0, -1).concat({ ...tail, content: `${tail.content}.${index}` });
    const result = projectCorpus(messages);
    assert.equal(result.turnCount, 120);
  }
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < PERF_BUDGET_MS * 4, `100 streaming projections took ${elapsedMs.toFixed(1)}ms`);
});

function buildHydratedProjection(messages, enabled) {
  const state = { features: { featureFlags: { chat_long_thread_bounds: enabled } }, pendingStreams: new Map(), ui: {} };
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
  const fingerprints = computeMessageFingerprintList(messages);
  const fingerprintById = new Map(messages.map((message, index) => [message.id, fingerprints[index].content]));
  const cache = new Map();
  const projection = hydration.buildHydratedTurnProjection(
    messages,
    null,
    { turnEventLogVersion: 0, turnEvents: [] },
    { turnRowCache: cache, messageContentFingerprintById: fingerprintById, sessionId: 'r2-session' }
  );
  return { cache, projection, stats: state.ui.longThreadBudgetStats };
}

test('R2 retains identical full projection while capping only rebuildable turn cache', () => {
  const messages = buildCorpus(220, 'tool');
  const bounded = buildHydratedProjection(messages, true);
  assert.equal(bounded.projection.turnTree.turns.length, 220);
  assert.equal(bounded.projection.rowsByTurnId.size, 220);
  assert.equal(bounded.cache.size, BUDGETS.projectedTurns);
  assert.equal(bounded.cache.has('r2_stream_219'), true, 'newest/active turn remains cached');
  assert.equal(bounded.stats.projectedTurnCacheEntries, BUDGETS.projectedTurns);
  assert.equal(bounded.stats.projectedTurns, 220);
  assert.ok(Number.isFinite(bounded.stats.projectionMs));

  const rollback = buildHydratedProjection(messages, false);
  assert.equal(rollback.projection.turnTree.turns.length, bounded.projection.turnTree.turns.length);
  assert.equal(rollback.projection.rowsByTurnId.size, bounded.projection.rowsByTurnId.size);
  assert.ok(rollback.cache.size > BUDGETS.projectedTurns, 'rollback restores the prior full cache');
});
