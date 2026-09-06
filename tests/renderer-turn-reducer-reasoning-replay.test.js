// 2026-08-29 duplicate-Thought-row fix: a same-phase reasoning event arriving
// after the assistant text row must update the existing reasoning row in place
// when it carries no unseen entry ids, while a genuinely new entry id still
// opens a second row (projector-parity split). Own file — the main reducer
// suite sits at the 600-line ratchet / 1015 ceiling.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');

function applyEvent(state, event) {
  state.__testEventOrdinal = Number(state.__testEventOrdinal || 0);
  applyTurnStreamEvent(state, {
    event_id: `stream-batch5:direct:${state.__testEventOrdinal}`,
    turn_id: 'stream-batch5',
    primary_message_id: 'assistant_stream-batch5',
    source_message_ids: ['assistant_stream-batch5'],
    sort_key: [0, state.__testEventOrdinal, 0],
    ...event,
  });
  state.__testEventOrdinal += 1;
  return state.turns_by_id['stream-batch5'];
}

test('reducer reuses a non-tail reasoning row for already-seen entry ids without recounting chunks', () => {
  const state = createTurnReducerState();

  const initialTurn = applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-replayed',
    status: 'open',
    payload: {
      entries: [{ id: 'reason-replayed', text: 'Working.' }],
      chunk_count: 3,
    },
  });
  const reasoningRow = initialTurn.rows[0];
  assert.equal(reasoningRow.payload.chunk_count, 3);

  applyEvent(state, {
    kind: 'assistant_text_segment',
    assistant_phase: 'final_answer',
    payload: { text: 'Done.', segment_id: 'segment-replayed' },
  });
  const turn = applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-replayed',
    status: 'completed',
    payload: {
      completed: true,
      entries: [{ id: 'reason-replayed', text: 'Working complete.' }],
      chunk_count: 3,
    },
  });

  assert.deepEqual(turn.rows.map((row) => row.kind), ['reasoning', 'assistant_text']);
  assert.strictEqual(turn.rows[0], reasoningRow);
  assert.equal(turn.rows[0].payload.completed, true);
  assert.equal(turn.rows[0].payload.entries[0].text, 'Working complete.');
  assert.equal(turn.rows[0].payload.chunk_count, 3);
});

// Lockstep discharge (2026-08-29 review): the reducer's echo sequence and the
// projector's persisted equivalent must agree. The collector coalesces the
// same-phase echo at capture time, so the persisted log carries ONE
// reasoning_phase event — the projector must yield the same row multiset the
// reducer reaches after merging the live echo.
test('reducer echo merge stays in lockstep with the projector on the persisted shape', () => {
  const state = createTurnReducerState();
  applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-lockstep',
    payload: { entries: [{ id: 'e1', text: 'Working.' }] },
  });
  applyEvent(state, {
    kind: 'assistant_text_segment',
    assistant_phase: 'final_answer',
    payload: { text: 'Answer.', segment_id: 'segment-lockstep' },
  });
  const turn = applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-lockstep',
    status: 'completed',
    payload: { completed: true, entries: [{ id: 'e1', text: 'Working.' }] },
  });

  const persistedEvents = [
    {
      event_id: 'stream-batch5:reasoning_phase:0',
      event_seq: 0,
      turn_id: 'stream-batch5',
      kind: 'reasoning_phase',
      status: 'completed',
      primary_message_id: 'assistant_stream-batch5',
      source_message_ids: ['assistant_stream-batch5'],
      phase_id: 'phase-lockstep',
      sort_key: [0, 0, 0],
      payload: { completed: true, entries: [{ id: 'e1', text: 'Working.' }] },
    },
    {
      event_id: 'stream-batch5:assistant_text_segment:0',
      event_seq: 1,
      turn_id: 'stream-batch5',
      kind: 'assistant_text_segment',
      status: '',
      primary_message_id: 'assistant_stream-batch5',
      source_message_ids: ['assistant_stream-batch5'],
      sort_key: [0, 1, 0],
      payload: { text: 'Answer.', segment_id: 'segment-lockstep' },
    },
  ];
  const projectedRows = projectTurnRows(persistedEvents);

  assert.deepEqual(
    turn.rows.map((row) => row.kind),
    projectedRows.map((row) => row.kind),
  );
  const reducerReasoning = turn.rows.filter((row) => row.kind === 'reasoning');
  const projectedReasoning = projectedRows.filter((row) => row.kind === 'reasoning');
  assert.equal(reducerReasoning.length, 1);
  assert.equal(projectedReasoning.length, 1);
  assert.deepEqual(
    reducerReasoning[0].payload.entries.map((entry) => entry.id),
    projectedReasoning[0].payload.entries.map((entry) => entry.id),
  );
});

test('reducer preserves a same-phase split when a new reasoning entry follows an intervening row', () => {
  const state = createTurnReducerState();

  applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-split',
    payload: { entries: [{ id: 'reason-before', text: 'Before.' }] },
  });
  applyEvent(state, {
    kind: 'assistant_text_segment',
    assistant_phase: 'commentary',
    payload: { text: 'Between.', segment_id: 'segment-between' },
  });
  const turn = applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-split',
    payload: { entries: [{ id: 'reason-after', text: 'After.' }] },
  });

  assert.deepEqual(turn.rows.map((row) => row.kind), ['reasoning', 'assistant_text', 'reasoning']);
  assert.deepEqual(turn.rows[0].payload.entries.map((entry) => entry.id), ['reason-before']);
  assert.deepEqual(turn.rows[2].payload.entries.map((entry) => entry.id), ['reason-after']);
});

test('reducer applies entryless completion updates to a non-tail reasoning row in place', () => {
  const state = createTurnReducerState();

  const initialTurn = applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-completion-only',
    payload: { entries: [{ id: 'reason-completion-only', text: 'Working.' }] },
  });
  const reasoningRow = initialTurn.rows[0];
  applyEvent(state, {
    kind: 'assistant_text_segment',
    assistant_phase: 'final_answer',
    payload: { text: 'Complete.', segment_id: 'segment-complete' },
  });
  const turn = applyEvent(state, {
    kind: 'reasoning_phase',
    phase_id: 'phase-completion-only',
    status: 'completed',
    completed_at: '2026-08-29T12:00:00.000Z',
    payload: { entries: [] },
  });

  assert.deepEqual(turn.rows.map((row) => row.kind), ['reasoning', 'assistant_text']);
  assert.strictEqual(turn.rows[0], reasoningRow);
  assert.equal(turn.rows[0].payload.completed, true);
  assert.equal(turn.rows[0].payload.completed_at, '2026-08-29T12:00:00.000Z');
});
