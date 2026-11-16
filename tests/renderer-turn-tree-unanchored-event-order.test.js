'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { projectPersistedEventsWithReducer } = require('../renderer/chat/renderer-stream-rehydrate');

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
    event('thought', 'reasoning_phase', 'assistant_stream_new_seg1', { phase_id: 'phase_1', payload: { text: 'Done.', entries: [{ id: 'r1', text: 'Done.' }] } }),
  ];
  for (const [position, extraEvent] of extra) {
    recorded.splice(position, 0, event(...extraEvent));
  }
  const turnEvents = withEventSeq
    ? recorded.map((entry, eventSeq) => ({ ...entry, event_seq: eventSeq }))
    : recorded;
  const tree = projectTurnTree({ messages, turn_event_log_version: 4, turn_events: turnEvents });
  const turn = tree.turns.find((entry) => entry.turn_id === 'turn_new');
  // The rows each path paints, by their first event: reopen (projectTurnRows)
  // and the terminal fold (the reducer replaying turn.events).
  const rowOrder = (rows) => rows.map((row) => row.source_events[0]);
  return {
    recordedOrder: recorded.map((entry) => entry.event_id),
    projectedOrder: turn.events.map((entry) => entry.event_id),
    reopenedRowOrder: rowOrder(projectTurnRows(turn.events, { deterministicRowId: true })),
    foldedRowOrder: rowOrder(projectPersistedEventsWithReducer(turn.events, { turnId: 'turn_new', deterministicRowId: true }).rows),
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

// The store records projected notices ahead of the turn's captured events and
// projected progress after them, each naming the message it rode on.
test('a notice recorded at the turn top and progress recorded at the end paint where their messages are', () => {
  const { reopenedRowOrder, foldedRowOrder } = projectToolTurn({
    withEventSeq: true,
    extra: [
      [1, ['notice', 'system_notice', 'assistant_stream_new_seg1', { payload: { subkind: 'context_compacted', text: 'compacted' } }]],
      [6, ['progress', 'agent_progress', 'assistant_stream_new_seg0', { payload: { steps: [{ label: 'step', status: 'running' }] } }]],
    ],
  });
  const expected = ['prompt', 'text_0', 'progress', 'tool_start', 'tool_done', 'notice', 'thought'];
  assert.deepEqual(reopenedRowOrder, expected);
  assert.deepEqual(foldedRowOrder.filter((id) => id !== 'tool_done'), expected.filter((id) => id !== 'tool_done'));
});

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

// order-reopen #6: a resumed turn settles with [paused-leg events from the
// store (session-wide event_seq, 300 and up), ...the resumed leg's carried
// events (no event_seq; the builder gives them their list index)], as
// withEarlierAttemptEvents in renderer-stream-handler-reducer-wiring.js joins
// them. Rows sort by sort_key (message first), so the paused leg stays first,
// and the call the resumed leg ran is no longer waiting for approval.
function projectResumedTurn() {
  const { projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
  const messages = normalizeChatMessages([
    { id: 'user_x', role: 'user', content: 'write it', parent_stream_id: 'stream_a', turn_id: 'turn_x' },
    { id: 'assistant_stream_a_seg0', role: 'assistant', content: 'First I check.', parent_stream_id: 'stream_a', turn_id: 'turn_x' },
    { id: 'tool_use_stream_a_call_w', role: 'assistant', kind: 'tool_use', parent_stream_id: 'stream_a', turn_id: 'turn_x',
      tool_call: { call_id: 'call_w', tool_name: 'write_file', input: { path: 'a.md' }, status: 'completed' } },
    { id: 'tool_result_stream_b_call_w', role: 'tool', kind: 'tool_result', parent_stream_id: 'stream_b', turn_id: 'turn_x',
      tool_result: { call_id: 'call_w', tool_name: 'write_file', output_text: 'ok' } },
    { id: 'assistant_stream_b_seg0', role: 'assistant', content: 'Written.', parent_stream_id: 'stream_b', turn_id: 'turn_x' },
  ]);
  const event = (eventId, kind, messageId, fields = {}) => ({
    event_id: eventId, turn_id: 'turn_x', kind, primary_message_id: messageId,
    source_message_ids: messageId ? [messageId] : [], payload: {}, ...fields,
  });
  const earlier = [
    event('prompt', 'user_prompt', 'user_x', { payload: { content: 'write it', attachments: [] } }),
    event('text_a', 'assistant_text_segment', 'assistant_stream_a_seg0', { payload: { text: 'First I check.' } }),
    event('tool_req', 'tool_use', 'tool_use_stream_a_call_w', { tool_call_id: 'call_w', status: 'pending_approval',
      payload: { tool_name: 'write_file', input: { path: 'a.md' } } }),
    event('approval_ask', 'approval_requested', 'tool_use_stream_a_call_w', { tool_call_id: 'call_w', payload: { tool_name: 'write_file' } }),
  ].map((entry, index) => ({ ...entry, event_seq: 300 + index }));
  const carried = [
    event('approval_ok', 'approval_resolved', 'tool_use_stream_a_call_w', { tool_call_id: 'call_w', status: 'approved', payload: { decision: 'approved' } }),
    event('tool_done', 'tool_result', 'tool_result_stream_b_call_w', { tool_call_id: 'call_w', status: 'completed',
      source_message_ids: ['tool_use_stream_a_call_w', 'tool_result_stream_b_call_w'], payload: { tool_name: 'write_file', output_text: 'ok' } }),
    event('text_b', 'assistant_text_segment', 'assistant_stream_b_seg0', { payload: { text: 'Written.' } }),
  ];
  const tree = projectTurnTree({ messages, turn_event_log_version: 4, turn_events: [...earlier, ...carried] });
  const turn = tree.turns.find((entry) => entry.turn_id === 'turn_x');
  const messageById = new Map(messages.map((message) => [message.id, message]));
  return { turn, projection: projectTurn(turn, { messageById, deterministicRowId: true }) };
}

test('a resumed turn keeps the paused leg first and its approved call settled (projectTurn and fold)', () => {
  const { turn, projection } = projectResumedTurn();
  const label = (row) => (row.kind === 'assistant_text' ? `text:${row.payload.text}` : row.kind);
  const visible = (rows) => rows.map(label).filter((kind) => kind !== 'tool_result' && kind !== 'approval_gap');
  assert.deepEqual(visible(projection.rows), ['user_bubble', 'text:First I check.', 'tool_call', 'text:Written.']);
  const folded = projectPersistedEventsWithReducer(turn.events, { turnId: 'turn_x', deterministicRowId: true }).rows;
  assert.deepEqual(visible(folded), visible(projection.rows), 'the terminal fold paints the same order');
  const call = projection.viewModel.toolCalls.find((toolCall) => toolCall.toolCallId === 'call_w');
  assert.notEqual(call.state, 'awaiting_approval', 'the call the resumed leg ran waits on nothing');
  const callRow = projection.rows.find((row) => row.kind === 'tool_call');
  assert.notEqual(callRow.payload.state, 'awaiting_approval', 'the reopened card is not an Approve card');
});

// order-reopen #5: an event whose primary id names no saved message (main
// writes assistant_<stream>; the saved id is _seg<N>) but whose
// source_message_ids hold the real id anchors on the real id.
test('an event with a phantom primary id anchors on its real source id', () => {
  const { recordedOrder, projectedOrder, reopenedRowOrder } = projectToolTurn({
    withEventSeq: true,
    extra: [
      [5, ['late_thought', 'reasoning_phase', 'assistant_stream_new', { phase_id: 'phase_0',
        source_message_ids: ['assistant_stream_new_seg0'], payload: { entries: [{ id: 'r0', text: 'Plan.' }] } }]],
    ],
  });
  assert.ok(projectedOrder.indexOf('late_thought') < projectedOrder.indexOf('tool_start'),
    `the thought sits at its real message, before the tool: ${projectedOrder} (recorded ${recordedOrder})`);
  assert.ok(reopenedRowOrder.indexOf('late_thought') < reopenedRowOrder.indexOf('tool_start'), `${reopenedRowOrder}`);
});

// order-reopen #5, second half: a turn's leading unanchored event does not
// sort by its session-wide event_seq against the message positions of the rest.
test('a leading unanchored event in a log with large event_seq values stays at the turn top', () => {
  const messages = normalizeChatMessages([
    { id: 'assistant_stream_r_seg0', role: 'assistant', content: 'Resumed.', parent_stream_id: 'stream_r', turn_id: 'turn_r' },
    { id: 'tool_use_stream_r_call_b', role: 'assistant', kind: 'tool_use', parent_stream_id: 'stream_r', turn_id: 'turn_r',
      tool_call: { call_id: 'call_b', tool_name: 'read_file', input: {} } },
    { id: 'assistant_stream_r_seg1', role: 'assistant', content: 'Done.', parent_stream_id: 'stream_r', turn_id: 'turn_r' },
  ]);
  const event = (eventId, kind, messageId, fields = {}) => ({
    event_id: eventId, turn_id: 'turn_r', kind, primary_message_id: messageId,
    source_message_ids: messageId ? [messageId] : [], payload: {}, ...fields,
  });
  const recorded = [
    event('resume_note', 'system_notice', '', { payload: { subkind: 'resumed', text: 'resumed' } }),
    event('text_0', 'assistant_text_segment', 'assistant_stream_r_seg0', { payload: { text: 'Resumed.' } }),
    event('tool_b', 'tool_use', 'tool_use_stream_r_call_b', { tool_call_id: 'call_b', payload: { tool_name: 'read_file' } }),
    event('text_1', 'assistant_text_segment', 'assistant_stream_r_seg1', { payload: { text: 'Done.' } }),
  ].map((entry, index) => ({ ...entry, event_seq: 500 + index }));
  const tree = projectTurnTree({ messages, turn_event_log_version: 4, turn_events: recorded });
  const turn = tree.turns.find((entry) => entry.turn_id === 'turn_r');
  assert.equal(turn.events[0].event_id, 'resume_note', `turn.events: ${turn.events.map((entry) => entry.event_id)}`);
  assert.equal(projectTurnRows(turn.events, { deterministicRowId: true })[0].source_events[0], 'resume_note');
});

// order-reopen #7: after whole-turn log compaction the oldest turns have no
// events and are rebuilt from their messages. They keep their place in the
// chat, so the newest turn is still the last one (two consumers read it).
test('turns rebuilt from messages after log compaction keep their chat position', () => {
  const messages = normalizeChatMessages([
    { id: 'user_old', role: 'user', content: 'earlier', parent_stream_id: 'stream_old', turn_id: 'stream_old' },
    { id: 'assistant_stream_old', role: 'assistant', content: 'earlier answer', parent_stream_id: 'stream_old', streamId: 'stream_old', turn_id: 'stream_old' },
    { id: 'user_new', role: 'user', content: 'now', parent_stream_id: 'stream_new', turn_id: 'turn_new' },
    { id: 'assistant_stream_new_seg0', role: 'assistant', content: 'Now then.', parent_stream_id: 'stream_new', turn_id: 'turn_new' },
  ]);
  const event = (eventId, kind, messageId, fields = {}) => ({
    event_id: eventId, turn_id: 'turn_new', kind, primary_message_id: messageId,
    source_message_ids: [messageId], payload: {}, ...fields,
  });
  const turnEvents = [
    event('prompt', 'user_prompt', 'user_new', { payload: { content: 'now', attachments: [] } }),
    event('text_0', 'assistant_text_segment', 'assistant_stream_new_seg0', { payload: { text: 'Now then.' } }),
  ].map((entry, index) => ({ ...entry, event_seq: 900 + index }));
  const tree = projectTurnTree({ messages, turn_event_log_version: 4, turn_events: turnEvents });
  const order = tree.turns.map((turn) => turn.turn_id);
  assert.equal(order.at(-1), 'turn_new', `the newest turn is last: ${order}`);
  assert.ok(order.length >= 2 && order.indexOf('turn_new') > 0, `the compacted turn sits before it: ${order}`);
});
