'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildNextTurnContextSummary } = require('../services/backend/next-turn-context-summary');

test('uses canonical history shaping and returns only bounded metadata', () => {
  const secret = 'POISONED_TOOL_OUTPUT_DO_NOT_EXPOSE';
  const messages = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `${secret}-${index}`,
  }));
  const store = { getSession: () => ({
    messages,
    context_preferences: {
      history_scope: 'recent', include_personality: true, include_memory: true,
      include_git_context: false, include_codebase_context: true, include_active_file_context: true,
    },
    linked_session_ids: ['a', 'b'],
    compaction_snapshot: { summary: secret },
  }) };
  const summary = buildNextTurnContextSummary(store, 'session-1', {
    attachment_count: 999, has_active_file: true, has_mentions: true,
  });
  assert.equal(summary.status, 'estimated');
  assert.equal(summary.history_scope, 'recent');
  assert.equal(summary.automatic_narrowing, true);
  assert.equal(summary.context_categories.attachments, 64);
  assert.equal(summary.context_categories.active_file, true);
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test('fails closed for malformed or missing sessions', () => {
  assert.deepEqual(buildNextTurnContextSummary(null, 'x'), { status: 'unavailable', reason: 'session_unavailable' });
  assert.deepEqual(buildNextTurnContextSummary({ getSession: () => null }, 'x'), { status: 'unavailable', reason: 'session_not_found' });
  assert.deepEqual(buildNextTurnContextSummary({ getSession: () => { throw new Error('private path'); } }, 'x'), {
    status: 'unavailable', reason: 'session_read_failed',
  });
});

test('counts provider-shaped history after filtering and tool-call folding', () => {
  const store = { getSession: () => ({
    messages: [
      { id: 'u1', role: 'user', content: 'Question' },
      { id: 'p1', role: 'assistant', kind: 'proactive_suggestion', content: 'Ignore me' },
      { id: 'a1', role: 'assistant', content: 'I will inspect it.' },
      {
        id: 'a2', role: 'assistant', kind: 'tool_use', content: '',
        tool_call: { call_id: 'c1', tool_name: 'read_file', input: { path: 'x' } },
      },
    ],
    context_preferences: { history_scope: 'session' },
    compaction_snapshot: { summary: 'malformed legacy data' },
  }) };
  const summary = buildNextTurnContextSummary(store, 'session-1');
  assert.equal(summary.history_message_count, 2);
  assert.equal(summary.available_history_message_count, 2);
  assert.equal(summary.compaction_snapshot_present, false);
});
