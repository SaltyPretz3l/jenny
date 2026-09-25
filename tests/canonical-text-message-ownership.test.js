'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getSessionMessages } = require('../services/backend/backend-sessions');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { buildCanonicalTurnEvent } = require('../services/backend/canonical-turn-event');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');

function fixture() {
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn_logical', attemptId: 'stream_physical', canonicalPrimary: true,
  });
  const content = 'Inspect `D:\\tmp\\jenny-wt\\session-runtime` before continuing.';
  const messages = [
    { id: 'user_stream_physical', role: 'user', turn_id: 'turn_logical', content: 'Audit' },
    { id: 'assistant_stream_physical_seg0', role: 'assistant', turn_id: 'turn_logical',
      parent_stream_id: 'stream_physical', content: 'First I will ask.' },
    { id: 'assistant_stream_physical_seg1', role: 'assistant', turn_id: 'turn_logical',
      parent_stream_id: 'stream_physical', content },
  ];
  collector.noteEvent({
    turn_id: 'turn_logical', kind: 'assistant_text_segment', event_id: 'commentary',
    primary_message_id: messages[1].id, source_message_ids: [messages[1].id],
    payload: { text: messages[1].content, assistant_phase: 'commentary' },
  });
  const final = collector.noteEvent(buildCanonicalTurnEvent({
    type: 'text_part_completed', turn_id: 'turn_logical', seq: 12,
    event_id: 'stream_physical:canonical:12',
    payload: { text: content, trace_id: 'stream_physical', assistant_phase: 'final_answer' },
  }));
  assert.match(final.payload.text, /\[redacted:path\]/);
  return { collector, messages, final };
}

test('canonical finalization assigns a segmented response to its actual saved message', () => {
  const { collector, messages, final } = fixture();
  const events = collector.buildFinalizedTurnEvents('turn_logical', messages);
  const persisted = events.find(event => event.event_id === final.event_id);
  assert.equal(persisted.primary_message_id, messages[2].id);
  assert.deepEqual(persisted.source_message_ids, [messages[2].id]);
  assert.deepEqual(persisted.payload, final.payload, 'ownership must not change canonical content');
  assert.equal(events.filter(event => event.kind === 'assistant_text_segment').length, 2);
});

test('session reads repair old missing-base text ownership without rewriting the record', async () => {
  const { collector, messages, final } = fixture();
  const session = { messages, turn_event_log_version: 4,
    turn_events: collector.capturedEvents.map((event, event_seq) => ({ ...event, event_seq })) };
  const before = JSON.stringify(session);
  const response = await getSessionMessages({ sessionStore: { getSession: () => session } }, 'session');
  const tree = projectTurnTree({ messages: response.data,
    turn_event_log_version: response.turn_event_log_version, turn_events: response.turn_events });
  assert.equal(tree.byMessageId[messages[2].id], 'turn_logical', 'the final response must not fall through to a second legacy article');
  assert.equal(response.turn_events.find(event => event.event_id === final.event_id).primary_message_id, messages[2].id);
  assert.equal(JSON.stringify(session), before);
});

for (const shape of ['different_text', 'different_attempt', 'different_turn', 'ambiguous', 'existing_base']) {
  test(`ownership recovery preserves unmatched records: ${shape}`, async () => {
    const { messages, final } = fixture();
    if (shape === 'different_text') messages[2].content = 'A separate response that must stay visible.';
    if (shape === 'different_attempt') messages[2].parent_stream_id = 'another_attempt';
    if (shape === 'different_turn') messages[2].turn_id = 'another_turn';
    if (shape === 'ambiguous') messages.push({ ...messages[2], id: 'assistant_stream_physical_seg2' });
    if (shape === 'existing_base') messages.push({ ...messages[2], id: 'assistant_stream_physical' });
    const session = { messages, turn_event_log_version: 4, turn_events: [final] };
    const response = await getSessionMessages({ sessionStore: { getSession: () => session } }, 'session');
    assert.equal(response.turn_events[0].primary_message_id, 'assistant_stream_physical');
  });
}
