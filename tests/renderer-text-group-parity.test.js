const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { indexRowsByRenderMessageId } = require('../renderer/chat/renderer-render-message-index-utils');

const TURN = 'turn_text_group_parity';
const USER = 'user_text_group_parity';
const A = 'assistant_text_group_a';
const B = 'assistant_text_group_b';
const PHASE = {
  phase_id: 'phase_text_group_reasoning',
  phase_kind: 'reasoning',
  thinking_id: 'think_text_group_reasoning',
};

function buildStreamEvents() {
  const sequence = [
    { payload: { type: 'started' }, messageId: A },
    { payload: { type: 'delta', content: 'alpha' }, messageId: A, segmentIndex: 0 },
    { payload: { type: 'phase_started', phase: PHASE }, messageId: A },
    {
      payload: {
        type: 'delta',
        phase: PHASE,
        reasoning: { entriesDelta: [{ id: 'reason_text_group', text: 'One thought.' }] },
        content: '',
      },
      messageId: A,
    },
    { payload: { type: 'phase_completed', phase: PHASE }, messageId: A },
    { payload: { type: 'delta', content: 'beta' }, messageId: A, segmentIndex: 1 },
    { payload: { type: 'delta', content: 'gamma' }, messageId: B, segmentIndex: 0 },
    { payload: { type: 'complete' }, messageId: B },
  ];
  return sequence.flatMap(({ payload, messageId, segmentIndex }, ordinal) => {
    const events = buildTurnEventFromStreamPayload({ ...payload, streamId: TURN }, {
      turn_id: TURN,
      primary_user_message_id: USER,
      primary_assistant_message_id: messageId,
      ordinal: ordinal + 1,
      sort_key: [ordinal, 0, 0],
      segment_index: segmentIndex,
      assistant_phase: 'final_answer',
    });
    return Array.isArray(events) ? events : [events];
  });
}

function persistedEventsFromStream(events) {
  // Persist content events in the journal shape, without live routing fields.
  // The existing identity-parity fixture likewise omits started/complete frames.
  return events
    .filter((event) => event.kind === 'assistant_text_segment' || event.kind === 'reasoning_phase')
    .map((event, eventSeq) => ({
      event_id: event.event_id,
      event_seq: eventSeq,
      turn_id: event.turn_id,
      kind: event.kind,
      primary_message_id: event.primary_message_id,
      source_message_ids: event.source_message_ids.slice(),
      ...(event.phase_id ? { phase_id: event.phase_id } : {}),
      ...(event.status ? { status: event.status } : {}),
      payload: {
        ...JSON.parse(JSON.stringify(event.payload)),
        ...(event.assistant_phase ? { assistant_phase: event.assistant_phase } : {}),
      },
    }));
}

function textGroupIndexes(rows) {
  return {
    A: rows.filter((row) => row.kind === 'assistant_text' && row.primary_message_id === A)
      .map((row) => row.segment_group_index),
    B: rows.filter((row) => row.kind === 'assistant_text' && row.primary_message_id === B)
      .map((row) => row.segment_group_index),
  };
}

test('live and canonical text groups agree around reasoning and deduplicate the following message', () => {
  const events = buildStreamEvents();
  const persistedEvents = persistedEventsFromStream(events);
  const state = createTurnReducerState();
  // Isolate mutable reducer payloads from the persisted copy of the same input.
  applyTurnStreamEvent(state, JSON.parse(JSON.stringify(events)));
  const liveTurn = state.turns_by_id[TURN];
  const liveRows = liveTurn.rows.map((row) => ({ ...row, _dedup_source: 'live' }));
  const tree = projectTurnTree({
    messages: [],
    turn_event_log_version: 1,
    turn_events: persistedEvents,
  });
  const canonicalRows = projectTurnRows(tree.byTurnId[TURN].events);
  const liveGroups = textGroupIndexes(liveRows);
  const canonicalGroups = textGroupIndexes(canonicalRows);
  const diagnostic = `segment_group_index: live=${JSON.stringify(liveGroups)}; canonical=${JSON.stringify(canonicalGroups)}`;

  assert.equal(liveTurn.status, events.at(-1).terminal_status, diagnostic);
  assert.deepEqual(canonicalRows.map((row) => row.kind),
    ['assistant_text', 'reasoning', 'assistant_text', 'assistant_text'], diagnostic);
  assert.deepEqual(canonicalRows.filter((row) => row.kind === 'assistant_text').map((row) => row.payload.text),
    ['alpha', 'beta', 'gamma'], diagnostic);
  for (const rows of [liveRows, canonicalRows]) {
    assert.equal(rows.filter((row) => row.kind === 'assistant_text').map((row) => row.payload.text).join(''),
      'alphabetagamma', diagnostic);
    assert.equal(rows.find((row) => row.kind === 'reasoning').payload.entries.length, 1, diagnostic);
  }

  const indexedBRowCounts = [
    [liveRows, canonicalRows],
    [canonicalRows, liveRows],
  ].map((producers) => {
    const index = indexRowsByRenderMessageId(new Map(
      producers.map((rows, position) => [`projection_${position}`, rows])
    ));
    return Array.from(index.values()).flat()
      .filter((row) => row.kind === 'assistant_text' && row.primary_message_id === B).length;
  });
  assert.deepEqual({ indexedBRowCounts, liveGroups, canonicalGroups }, {
    indexedBRowCounts: [1, 1],
    liveGroups: { A: [0, 1], B: [2] },
    canonicalGroups: { A: [0, 1], B: [2] },
  }, `B must appear once in either union order and every text-group index must agree; ${diagnostic}`);
});
