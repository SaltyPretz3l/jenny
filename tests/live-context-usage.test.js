'use strict';

// jenny_status budgets.context: the latest mid-turn context reading per session, falling back to
// the session record's last terminal reading, so a model can cite a figure before stopping.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_LIVE_SESSIONS, contextBudgetFor, noteLiveContextUsage } = require('../services/backend/live-context-usage');
const { buildContextUsageStreamEvent } = require('../services/backend/chat-stream-usage');

function midTurn(used, { window = 256000, threshold = 120668 } = {}) {
  return buildContextUsageStreamEvent({
    phase: 'iteration', iteration: 3, context_used_tokens: used, context_used_source: 'provider',
    last_request_input_tokens: used, context_window: window, compact_threshold_tokens: threshold,
    model: 'api-provider/anthropic-api/claude-opus-5-5',
  }).usage;
}

test('a mid-turn reading is reported as this turn, with its percent and compaction threshold', () => {
  const service = {};
  noteLiveContextUsage(service, 'sess_a', midTurn(144747));
  const context = contextBudgetFor(service, 'sess_a');
  assert.equal(context.used_tokens, 144747);
  assert.equal(context.context_window, 256000);
  assert.equal(context.used_percent, 57);
  assert.equal(context.compact_threshold_tokens, 120668);
  assert.equal(context.reading, 'this_turn');
  assert.match(context.note, /compacted automatically/u);
  noteLiveContextUsage(service, 'sess_a', midTurn(80000));
  assert.equal(contextBudgetFor(service, 'sess_a').used_tokens, 80000, 'compaction lowers it again');
});

test('without a live reading the session record seeds it; nothing at all reports null', () => {
  const service = { sessionStore: { getSessionSummary: (id) => (id === 'sess_b' ? {
    context_usage: { used_tokens: 50000, context_window: 0, compact_threshold_tokens: 0, updated_at: 't' },
  } : null) } };
  assert.deepEqual(
    { ...contextBudgetFor(service, 'sess_b'), note: '' },
    { used_tokens: 50000, context_window: null, used_percent: null, compact_threshold_tokens: null,
      reading: 'last_turn', updated_at: 't', note: '' },
  );
  assert.equal(contextBudgetFor(service, 'sess_none'), null);
  assert.equal(contextBudgetFor(service, ''), null);
  assert.equal(contextBudgetFor({ sessionStore: { getSessionSummary() { throw new Error('x'); } } }, 's'), null);
});

test('readings stay per session, bounded, and an empty reading is ignored', () => {
  const service = {};
  noteLiveContextUsage(service, 'sess_c', midTurn(0));
  noteLiveContextUsage(service, '', midTurn(10));
  assert.equal(service._liveContextUsage?.size ?? 0, 0);
  for (let index = 0; index <= MAX_LIVE_SESSIONS; index += 1) {
    noteLiveContextUsage(service, `sess_${index}`, midTurn(1000 + index));
  }
  assert.equal(service._liveContextUsage.size, MAX_LIVE_SESSIONS);
  assert.equal(contextBudgetFor(service, 'sess_0'), null, 'the oldest session is dropped');
  assert.equal(contextBudgetFor(service, `sess_${MAX_LIVE_SESSIONS}`).used_tokens, 1000 + MAX_LIVE_SESSIONS);
});
