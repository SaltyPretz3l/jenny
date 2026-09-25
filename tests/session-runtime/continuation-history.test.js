'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureRuntimeContinuationHistory } = require('../../services/backend/runtime-continuation-history');
const { buildPreparedContinuationPrefix } = require('../../services/backend/chat-stream-reasoning');

function source() {
  return { canonicalSessionMessages: [{ id: 'message-1', role: 'user', content: 'read this',
    attachments: [{ id: 'attachment-1', sha256: 'a'.repeat(64) }] }],
  contextPreferences: { history_scope: 'session' },
  frameOutcome: { fitsBudget: true, historyScopeFallback: null },
  compactedHistory: { applied: false }, sessionSummary: {} };
}

test('history captures the effective frame scope and full canonical cutoff without storing content', () => {
  const args = source();
  args.frameOutcome.historyScopeFallback = 'recent';
  const selector = captureRuntimeContinuationHistory(args);
  assert.equal(selector.history_scope, 'recent');
  assert.equal(selector.canonical_cutoff.boundary_message_count, 1);
  assert.equal(selector.canonical_cutoff.boundary_message_id, 'message-1');
  assert.equal(selector.compaction_ref, null);
  assert.equal(JSON.stringify(selector).includes('read this'), false);
  assert.equal(Object.isFrozen(selector), true);
  assert.equal(Object.isFrozen(selector.canonical_cutoff), true);
  const originalHash = selector.canonical_cutoff.sha256;
  args.canonicalSessionMessages[0].attachments[0].sha256 = 'b'.repeat(64);
  assert.notEqual(captureRuntimeContinuationHistory(args).canonical_cutoff.sha256, originalHash);
  assert.equal(selector.canonical_cutoff.sha256, originalHash);
});

test('empty first-turn history has a real empty digest and fresh scope is recorded', () => {
  const args = source();
  args.canonicalSessionMessages = [];
  args.contextPreferences.history_scope = 'fresh';
  const selector = captureRuntimeContinuationHistory(args);
  assert.equal(selector.history_scope, 'fresh');
  assert.equal(selector.canonical_cutoff.boundary_message_id, null);
  assert.equal(selector.canonical_cutoff.boundary_message_count, 0);
  assert.match(selector.canonical_cutoff.sha256, /^[0-9a-f]{64}$/u);
});

test('applied compaction pins normalized persisted snapshot content, not merely its boundary', () => {
  const args = source();
  args.compactedHistory.applied = true;
  args.sessionSummary.compaction_snapshot = { version: 2, origin: 'manual', strategy: 'full',
    created_at: '2026-09-10T00:00:00Z', tokens_before: 100, tokens_after: 20,
    boundary_message_id: 'message-1', boundary_message_count: 1,
    messages: [{ role: 'system', content: '## Compacted Conversation Summary\nA summary.' }] };
  const first = captureRuntimeContinuationHistory(args);
  args.sessionSummary.compaction_snapshot.messages[0].content += ' Changed.';
  assert.notEqual(captureRuntimeContinuationHistory(args).compaction_ref.sha256, first.compaction_ref.sha256);
  assert.equal(JSON.stringify(first).includes('A summary'), false);
  args.compactedHistory.applied = false;
  assert.equal(captureRuntimeContinuationHistory(args).compaction_ref, null);
});

test('unfitted frames, unknown scopes, and unavailable applied compaction fail closed', () => {
  for (const mutate of [
    (args) => { args.frameOutcome.fitsBudget = false; },
    (args) => { args.frameOutcome.historyScopeFallback = 'unknown'; },
    (args) => { args.compactedHistory.applied = true; },
    (args) => { args.canonicalSessionMessages[0].id = ''; },
  ]) {
    const args = source();
    mutate(args);
    assert.throws(() => captureRuntimeContinuationHistory(args));
  }
});

test('resumed prefix projects event-only text and deduplicates an already materialized assistant row', () => {
  const event = { event_id: 'event_1', kind: 'assistant_text_segment', primary_message_id: 'assistant_1',
    source_message_ids: ['assistant_1'], payload: { canonical_part_id: 'part_1', text: 'Saved commentary.' } };
  const reasoning = { event_id: 'reasoning_1', kind: 'reasoning_phase', payload: { text: 'Private reasoning.' } };
  assert.deepEqual(buildPreparedContinuationPrefix([], [reasoning, event]), [
    { role: 'assistant', content: 'Saved commentary.' },
  ]);
  const rows = [{ id: 'assistant_1', role: 'assistant', content: 'Saved commentary.' }];
  assert.deepEqual(buildPreparedContinuationPrefix(rows, [event, { ...event, event_id: 'event_2' }]), [
    { role: 'assistant', content: 'Saved commentary.' },
  ]);
  assert.deepEqual(buildPreparedContinuationPrefix([], [event, { ...event,
    event_id: 'event_2', payload: { ...event.payload, text: 'Updated same part.' } }]), [
    { role: 'assistant', content: 'Updated same part.' },
  ]);
  assert.throws(() => buildPreparedContinuationPrefix([
    { id: 'unrelated', role: 'assistant', content: 'Cannot infer placement.' },
  ], [event]), /prefix_order_unavailable/u);
});
