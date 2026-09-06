const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { buildTurnViewModel } = require('../renderer/chat/renderer-turn-view-model');

const STREAM_ID = 'stream-reasoning-wire-deltas';
const ASSISTANT_ID = `assistant_${STREAM_ID}`;

function createHarness() {
  const state = createTurnReducerState();
  let ordinal = 0;
  return {
    state,
    apply(payload, options = {}) {
      const turn = state.turns_by_id[STREAM_ID];
      const events = buildTurnEventFromStreamPayload(payload, {
        turn_id: STREAM_ID,
        ordinal,
        message_index: turn?.rows?.length || 0,
        intra_message_order: ordinal,
        primary_user_message_id: 'user-reasoning-wire-deltas',
        primary_assistant_message_id: ASSISTANT_ID,
        segment_text: Object.prototype.hasOwnProperty.call(options, 'segmentText')
          ? options.segmentText
          : undefined,
        segment_index: 0,
        phase_id: payload.phaseId || '',
      });
      ordinal += 1;
      applyTurnStreamEvent(state, events);
      const nextTurn = state.turns_by_id[STREAM_ID];
      nextTurn.next_sort_ordinal = ordinal;
      return nextTurn;
    },
  };
}

function reasoningDelta(entries, frame = 0) {
  return {
    type: 'delta',
    streamId: STREAM_ID,
    phaseId: 'p1',
    thinkingId: 'thinking-p1',
    reasoning: {
      entriesDelta: entries.map((entry) => ({
        timestamp: `2026-09-05T00:${String(frame).padStart(2, '0')}:00.000Z`,
        thinkingId: 't1',
        ...entry,
      })),
    },
  };
}

function reasoningRows(turn) {
  return turn.rows.filter((row) => row.kind === 'reasoning');
}

function projectedReasoningText(turn) {
  return projectTurnRows(turn.events)
    .filter((row) => row.kind === 'reasoning')
    .flatMap((row) => row.payload.entries)
    .map((entry) => String(entry.text || ''))
    .join('');
}

function buildAppendTurn() {
  const harness = createHarness();
  let cumulativeText = 'Hello';
  let turn = harness.apply(reasoningDelta([{ id: 'r1', text: cumulativeText }]));
  for (let frame = 1; frame <= 50; frame += 1) {
    const append = 'x'.repeat(100);
    turn = harness.apply(reasoningDelta([{
      id: 'r1',
      baseLength: cumulativeText.length,
      baseTail: cumulativeText.slice(-64),
      append,
    }], frame));
    cumulativeText += append;
  }
  return { cumulativeText, turn };
}

test('resolves 50 append edits before reasoning retention and row merge', () => {
  const { cumulativeText, turn } = buildAppendTurn();
  const retained = turn.events.filter((event) => event.kind === 'reasoning_phase');
  const row = reasoningRows(turn)[0];

  assert.equal(retained.length, 1);
  assert.equal(retained[0].payload.entries[0].text, cumulativeText);
  assert.equal(row.payload.entries[0].text, cumulativeText);
  assert.equal(turn.reasoning_edit_mismatches, 0);
  assert.equal(turn.seen_event_ids.size, 51);
  assert.equal(projectedReasoningText(turn), row.payload.entries[0].text);
});

test('drops a stale edit without retaining it and heals on the next snapshot', () => {
  const harness = createHarness();
  harness.apply(reasoningDelta([{ id: 'r1', text: 'Hello' }]));
  const mismatched = harness.apply(reasoningDelta([{
    id: 'r1', baseLength: 3, baseTail: 'Hel', append: ' stale',
  }], 1));

  assert.equal(reasoningRows(mismatched)[0].payload.entries[0].text, 'Hello');
  assert.equal(mismatched.events.length, 1);
  assert.equal(mismatched.reasoning_edit_mismatches, 1);
  assert.equal(mismatched.seen_event_ids.has(`${STREAM_ID}:delta:1:reasoning`), true);

  const healed = harness.apply(reasoningDelta([{ id: 'r1', text: 'Healed' }], 2));
  assert.equal(reasoningRows(healed)[0].payload.entries[0].text, 'Healed');
  assert.equal(projectedReasoningText(healed), 'Healed');
});

test('an all-dropped edit frame still carries its phase metadata to the row', () => {
  const harness = createHarness();
  harness.apply(reasoningDelta([{ id: 'r1', text: 'Hello' }]));
  const payload = reasoningDelta([{
    id: 'r1', baseLength: 3, baseTail: 'Hel', append: ' stale',
  }], 1);
  payload.summary = 'Weighing options';
  const turn = harness.apply(payload);

  const row = reasoningRows(turn)[0];
  assert.equal(row.payload.entries[0].text, 'Hello');
  assert.equal(row.payload.summary, 'Weighing options');
  assert.equal(turn.events.length, 1, 'the dropped frame is coalesced, not retained');
  assert.equal(turn.reasoning_edit_mismatches, 1);
  assert.equal(harness.state.active_turn_id, STREAM_ID);
});

test('resolves edits from a retained snapshot across a contiguity break', () => {
  const harness = createHarness();
  harness.apply(reasoningDelta([{ id: 'r1', text: '' }]));
  harness.apply({
    type: 'delta', streamId: STREAM_ID, content: 'Visible answer.',
  }, { segmentText: 'Visible answer.' });
  harness.apply(reasoningDelta([{ id: 'r1', baseLength: 0, baseTail: '', append: 'First' }], 2));
  const turn = harness.apply(reasoningDelta([{
    id: 'r1', baseLength: 5, baseTail: 'First', append: ' second',
  }], 3));

  assert.deepEqual(turn.events.map((event) => event.kind), [
    'reasoning_phase',
    'assistant_text_segment',
    'reasoning_phase',
  ]);
  assert.equal(reasoningRows(turn)[0].payload.entries[0].text, 'First second');
  assert.equal(projectedReasoningText(turn), 'First second');
  assert.equal(
    turn.events.every((event) => (event.payload?.entries || [])
      .every((entry) => Object.hasOwn(entry, 'text'))),
    true
  );
});

test('keeps snapshots and drops unknown edits from a mixed frame', () => {
  const harness = createHarness();
  const turn = harness.apply(reasoningDelta([
    { id: 'r1', text: 'Hello' },
    { id: 'r9', baseLength: 0, baseTail: '', append: 'unknown' },
  ]));

  assert.equal(turn.reasoning_edit_mismatches, 1);
  assert.equal(turn.events.length, 1);
  assert.deepEqual(turn.events[0].payload.entries.map((entry) => entry.id), ['r1']);
  assert.equal(reasoningRows(turn)[0].payload.entries[0].text, 'Hello');
});

test('drops an edit whose tail mismatches despite an equal base length', () => {
  const harness = createHarness();
  harness.apply(reasoningDelta([{ id: 'r1', text: 'abc<thi' }]));
  const turn = harness.apply(reasoningDelta([{
    id: 'r1', baseLength: 7, baseTail: 'abcWXYZ', append: 'Q',
  }], 1));

  assert.equal(reasoningRows(turn)[0].payload.entries[0].text, 'abc<thi');
  assert.equal(turn.reasoning_edit_mismatches, 1);
});

test('buildTurnViewModel sees one cumulative reasoning group after append edits', () => {
  const { cumulativeText, turn } = buildAppendTurn();
  const viewModel = buildTurnViewModel(turn);

  assert.equal(viewModel.reasoning.length, 1);
  assert.equal(
    viewModel.reasoning[0].entries.map((entry) => String(entry.text || '')).join(''),
    cumulativeText
  );
});
