'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  migrateStorePayload,
  repairSessionForV22,
} = require('../services/backend/session-store-migrations');

// Schema v22: failure-retry reasoning snapshots (WO-4b preservation half).

function v22Snapshot(userId, overrides = {}) {
  const text = overrides.text || 'saved reasoning';
  return {
    version: 1,
    user_message_id: userId,
    source_assistant_message_id: `assistant_${userId}`,
    source_turn_id: `turn_${userId}`,
    captured_at: '2026-09-04T00:00:00.000Z',
    cap_chars: 48_000,
    char_count: text.length,
    truncated: false,
    reasoning_entries: [{
      id: `entry_${userId}`,
      text,
      thinking_id: `thinking_${userId}`,
      timestamp: '2026-09-04T00:00:00.000Z',
    }],
    ...overrides,
  };
}


test('v21 to v22 initializes failure retry reasoning snapshots without touching messages or events', () => {
  const messages = [{ id: 'user_1', role: 'user', content: 'Keep me' }];
  const turnEvents = [{
    event_id: 'turn_1:user_bubble:0',
    turn_id: 'turn_1',
    kind: 'user_bubble',
    primary_message_id: 'user_1',
    payload: { text: 'Keep me' },
  }];
  const result = migrateStorePayload({
    schema_version: 21,
    sessions: { s1: { id: 's1', messages, turn_events: turnEvents } },
  });

  assert.equal(result.schema_version, 22);
  assert.deepEqual(result.sessions.s1.failure_retry_reasoning_snapshots, {});
  assert.deepEqual(result.sessions.s1.messages, messages);
  assert.deepEqual(result.sessions.s1.turn_events, turnEvents);
});

test('repairSessionForV22 isolates malformed keys, enforces each cap, and preserves unrelated state', () => {
  const messages = [{ id: 'user_1', role: 'user', content: 'Untouched' }];
  const turnEvents = [{ event_id: 'event_1', turn_id: 'turn_1', kind: 'system_notice' }];
  const repaired = repairSessionForV22({
    title: 'Preserved',
    messages,
    turn_events: turnEvents,
    failure_retry_reasoning_snapshots: {
      bad_version: v22Snapshot('bad_version', { version: 2 }),
      '': v22Snapshot(''),
      mismatched_key: v22Snapshot('different_user'),
      missing_assistant: v22Snapshot('missing_assistant', { source_assistant_message_id: '' }),
      missing_turn: v22Snapshot('missing_turn', { source_turn_id: '' }),
      invalid_captured_at: v22Snapshot('invalid_captured_at', { captured_at: 'invalid' }),
      bad_cap: v22Snapshot('bad_cap', { cap_chars: 999_999 }),
      entries_not_array: v22Snapshot('entries_not_array', { reasoning_entries: {} }),
      blank_text: v22Snapshot('blank_text', {
        reasoning_entries: [{
          id: 'blank', text: '   ', thinking_id: '',
          timestamp: '2026-09-04T00:00:00.000Z',
        }],
      }),
      invalid_entry_timestamp: v22Snapshot('invalid_entry_timestamp', {
        reasoning_entries: [{
          id: 'bad_timestamp', text: 'reasoning', thinking_id: '', timestamp: 'invalid',
        }],
      }),
      valid_later: v22Snapshot('valid_later'),
      capped: v22Snapshot('capped', {
        cap_chars: 5,
        reasoning_entries: [{
          id: 'entry_capped',
          text: '0123456789',
          thinking_id: 'thinking_capped',
          timestamp: '2026-09-04T00:00:00.000Z',
        }],
      }),
    },
  });

  assert.equal(repaired.title, 'Preserved');
  assert.deepEqual(repaired.messages, messages);
  assert.deepEqual(repaired.turn_events, turnEvents);
  assert.deepEqual(Object.keys(repaired.failure_retry_reasoning_snapshots).sort(), ['capped', 'valid_later']);
  assert.equal(repaired.failure_retry_reasoning_snapshots.capped.reasoning_entries[0].text, '56789');
  assert.equal(repaired.failure_retry_reasoning_snapshots.capped.char_count, 5);
  assert.equal(repaired.failure_retry_reasoning_snapshots.capped.truncated, true);
});
