'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');

// A chat with an earlier exchange, then a tool turn. `extra` events name no
// saved message, so they have no message position of their own.
function projectToolTurn({ withEventSeq, extra }) {
  const messages = normalizeChatMessages([
    { id: 'user_old', role: 'user', content: 'earlier', parent_stream_id: 'stream_old', turn_id: 'turn_old' },
    { id: 'assistant_old', role: 'assistant', content: 'earlier answer', parent_stream_id: 'stream_old', turn_id: 'turn_old' },
    { id: 'user_older', role: 'user', content: 'earlier still', parent_stream_id: 'stream_older', turn_id: 'turn_older' },
    { id: 'assistant_older', role: 'assistant', content: 'another answer', parent_stream_id: 'stream_older', turn_id: 'turn_older' },
    { id: 'user_new', role: 'user', content: 'review it', parent_stream_id: 'stream_new', turn_id: 'turn_new' },
    { id: 'assistant_stream_new_seg0', role: 'assistant', content: 'Looking.', parent_stream_id: 'stream_new', turn_id: 'turn_new' },
    { id: 'tool_use_stream_new_call_a', role: 'assistant', kind: 'tool_use', parent_stream_id: 'stream_new', turn_id: 'turn_new',
      tool_call: { id: 'call_a', name: 'read_file', input: {} } },
    { id: 'tool_result_stream_new_call_a', role: 'tool', kind: 'tool_result', parent_stream_id: 'stream_new', turn_id: 'turn_new',
      tool_result: { tool_call_id: 'call_a', output_text: 'ok' } },
    { id: 'assistant_stream_new_seg1', role: 'assistant', content: 'All good.', parent_stream_id: 'stream_new', turn_id: 'turn_new' },
  ]);
  const event = (eventId, kind, messageId, fields = {}) => ({
    event_id: eventId,
    turn_id: 'turn_new',
    kind,
    primary_message_id: messageId,
    source_message_ids: messageId ? [messageId] : [],
    payload: {},
    ...fields,
  });
  const recorded = [
    event('prompt', 'user_prompt', 'user_new', { payload: { content: 'review it', attachments: [] } }),
    event('text_0', 'assistant_text_segment', 'assistant_stream_new_seg0', { payload: { text: 'Looking.' } }),
    event('tool_start', 'tool_executing', 'tool_use_stream_new_call_a', { tool_call_id: 'call_a' }),
    event('tool_done', 'tool_result', 'tool_result_stream_new_call_a', { tool_call_id: 'call_a' }),
    event('thought', 'reasoning_phase', 'assistant_stream_new_seg1', { payload: { text: 'Done.' } }),
  ];
  for (const [position, extraEvent] of extra) {
    recorded.splice(position, 0, event(...extraEvent));
  }
  const turnEvents = withEventSeq
    ? recorded.map((entry, eventSeq) => ({ ...entry, event_seq: eventSeq }))
    : recorded;
  const tree = projectTurnTree({ messages, turn_event_log_version: 4, turn_events: turnEvents });
  const turn = tree.turns.find((entry) => entry.turn_id === 'turn_new');
  return {
    recordedOrder: recorded.map((entry) => entry.event_id),
    projectedOrder: turn.events.map((entry) => entry.event_id),
  };
}

// The log a finishing turn carries has no event_seq yet; the saved log has one.
for (const withEventSeq of [false, true]) {
  const label = withEventSeq ? 'saved log' : 'log carried at turn end';

  test(`a final answer that names a missing base message stays last (${label})`, () => {
    const { recordedOrder, projectedOrder } = projectToolTurn({
      withEventSeq,
      // Fifth in the list, while the first text of the turn is message 5.
      extra: [[5, ['final', 'assistant_text_segment', 'assistant_stream_new', { payload: { text: 'All good.' } }]]],
    });
    assert.deepEqual(projectedOrder, recordedOrder);
    assert.equal(projectedOrder.at(-1), 'final');
  });

  test(`an event with no message keeps the place it was recorded in (${label})`, () => {
    const { recordedOrder, projectedOrder } = projectToolTurn({
      withEventSeq,
      extra: [
        [4, ['notice_a', 'system_notice', '', { payload: { text: 'first' } }]],
        [5, ['notice_b', 'agent_progress', '', { payload: { text: 'second' } }]],
      ],
    });
    assert.deepEqual(projectedOrder, recordedOrder);
  });
}

test('a later event of the same message still follows an event that has no message', () => {
  const { recordedOrder, projectedOrder } = projectToolTurn({
    withEventSeq: true,
    extra: [
      [5, ['notice', 'system_notice', '', { payload: { text: 'between' } }]],
      [6, ['text_1', 'assistant_text_segment', 'assistant_stream_new_seg1', { payload: { text: 'All good.' } }]],
    ],
  });
  assert.deepEqual(projectedOrder, recordedOrder);
});
