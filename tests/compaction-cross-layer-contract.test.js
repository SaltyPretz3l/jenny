'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const contextUsageModel = require('../renderer/chat/renderer-context-usage-model');
const { estimateMessagesTokens } = require('../services/backend/context-budget-trimmer');
const {
  buildAutomaticCompactionSnapshot,
  buildCompactionSnapshotFromResult,
  summarizeCompactionSnapshot,
} = require('../services/backend/session-compaction-snapshot');

function buildHistoryFixture() {
  const messages = [
    { id: 'u1', role: 'user', content: 'first question' },
    { id: 'a1', role: 'assistant', content: 'first answer' },
    { id: 'u2', role: 'user', content: 'second question' },
    { id: 'a2', role: 'assistant', content: 'tail reply' },
    { id: 'u3', role: 'user', content: 'tail prompt' },
  ];
  const boundaryMessageCount = 3;
  return {
    messages,
    boundaryMessageCount,
    boundaryMessageId: messages[boundaryMessageCount - 1].id,
    tail: messages.slice(boundaryMessageCount),
  };
}

function assertCompactionEstimate(snapshot, history) {
  const opts = {
    historyScope: 'session',
    overheadTokens: 37,
    contextLimit: 8192,
    compactionContext: summarizeCompactionSnapshot(snapshot),
  };
  const result = contextUsageModel.buildContextUsageEstimate(history.messages, opts);
  const tailTokens = contextUsageModel.estimateContextMessagesTokens(history.tail, 'session');
  const replacementTokens = estimateMessagesTokens(snapshot.messages);

  assert.equal(result.usageSource, 'compaction');
  assert.equal(result.usedTokens, opts.overheadTokens + replacementTokens + tailTokens);
  // Guard against double-counting the leading system run already included in tokens_after.
  assert.notEqual(result.usedTokens, opts.overheadTokens + snapshot.tokens_after + tailTokens);
}

// RED AT HEAD: the renderer rejects version-2 snapshots (renderer-context-usage-model.js normalizeCompactionContext), so usageSource degrades to 'estimate'. S1/S2 turn this green.
test('automatic compaction projection preserves replacement tokens without double-counting overhead', () => {
  const history = buildHistoryFixture();
  const summaryMessage = {
    role: 'system',
    content: '## Compacted Conversation Summary\nDerived conversation data.\n\n' + 'A'.repeat(40),
  };
  const snapshot = buildAutomaticCompactionSnapshot({
    summaryMessage,
    tokensBefore: 4000,
    tokensAfter: 240,
    boundaryMessageId: history.boundaryMessageId,
    boundaryMessageCount: history.boundaryMessageCount,
  });

  assertCompactionEstimate(snapshot, history);
});

test('mid-turn two-message automatic replacement projects without double counting', () => {
  const history = buildHistoryFixture();
  const snapshot = buildAutomaticCompactionSnapshot({
    summaryMessage: {
      role: 'system',
      content: '## Compacted Conversation Summary\nDerived conversation data.\n\nMid-turn summary.',
    },
    taskMessage: { role: 'user', content: 'Continue the current request.' },
    tokensBefore: 4500,
    tokensAfter: 280,
    boundaryMessageId: history.boundaryMessageId,
    boundaryMessageCount: history.boundaryMessageCount,
  });

  assertCompactionEstimate(snapshot, history);
});

// RED AT HEAD: the renderer rejects version-2 snapshots (renderer-context-usage-model.js normalizeCompactionContext), so usageSource degrades to 'estimate'. S1/S2 turn this green.
test('manual compaction projection preserves replacement tokens without double-counting overhead', () => {
  const history = buildHistoryFixture();
  const replacementMessages = [
    { role: 'system', content: 'Manual compacted summary: ' + 'M'.repeat(40) },
    { role: 'user', content: 'Retained prompt' },
  ];
  const snapshot = buildCompactionSnapshotFromResult({
    status: 'ok',
    compacted: true,
    strategy: 'full',
    tokens_before: 5000,
    tokens_after: 300,
    messages: replacementMessages,
  }, {
    boundaryMessageId: history.boundaryMessageId,
    boundaryMessageCount: history.boundaryMessageCount,
  });

  assertCompactionEstimate(snapshot, history);
});
