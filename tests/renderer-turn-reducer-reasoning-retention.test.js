const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');

const STREAM_ID = 'stream-reasoning-retention';
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
        primary_user_message_id: 'user-reasoning-retention',
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

function reasoningDelta(phaseId, id, text, frame = 0) {
  return {
    type: 'delta',
    streamId: STREAM_ID,
    phaseId,
    thinkingId: `thinking-${phaseId}`,
    reasoning: {
      entriesDelta: [{ id, text, timestamp: `2026-09-05T00:00:${frame}.000Z`, thinkingId: 't1' }],
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

test('retains one latest reasoning snapshot across 2,000 same-phase frames', () => {
  const harness = createHarness();
  let cumulativeText = '';
  let turn;
  for (let frame = 0; frame < 2000; frame += 1) {
    cumulativeText += 'x'.repeat(100);
    turn = harness.apply(reasoningDelta('p1', 'r1', cumulativeText, frame));
  }

  const retained = turn.events.filter((event) => event.kind === 'reasoning_phase');
  const retainedTextLength = retained.reduce(
    (sum, event) => sum + event.payload.entries.reduce((entrySum, entry) => entrySum + String(entry.text || '').length, 0),
    0,
  );
  const row = reasoningRows(turn)[0];

  assert.equal(retained.length, 1);
  assert.ok(retainedTextLength <= 2 * cumulativeText.length);
  assert.equal(row.payload.entries[0].text, cumulativeText);
  assert.equal(turn.seen_event_ids.size, 2000);
  assert.equal(row.source_events.length, 1);
});

test('retains one latest event and one live row for each distinct phase', () => {
  const harness = createHarness();
  harness.apply(reasoningDelta('p1', 'r1', 'p1-first'));
  harness.apply(reasoningDelta('p1', 'r1', 'p1-latest', 1));
  harness.apply(reasoningDelta('p2', 'r2', 'p2-first', 2));
  const turn = harness.apply(reasoningDelta('p2', 'r2', 'p2-latest', 3));

  const retained = turn.events.filter((event) => event.kind === 'reasoning_phase');
  assert.deepEqual(retained.map((event) => event.phase_id), ['p1', 'p2']);
  assert.deepEqual(retained.map((event) => event.payload.entries[0].text), ['p1-latest', 'p2-latest']);
  assert.deepEqual(reasoningRows(turn).map((row) => row.payload.entries[0].text), ['p1-latest', 'p2-latest']);
});

test('an intervening text event breaks retention contiguity but same-id reasoning still updates its live row', () => {
  const harness = createHarness();
  harness.apply(reasoningDelta('p1', 'r1', ''));
  harness.apply(reasoningDelta('p1', 'r1', '', 1));
  harness.apply({ type: 'delta', streamId: STREAM_ID, content: 'Visible answer.' }, { segmentText: 'Visible answer.' });
  harness.apply(reasoningDelta('p1', 'r1', 'final reasoning', 3));
  const turn = harness.apply(reasoningDelta('p1', 'r1', 'final reasoning', 4));

  assert.deepEqual(turn.events.map((event) => event.kind), [
    'reasoning_phase',
    'assistant_text_segment',
    'reasoning_phase',
  ]);
  const rows = reasoningRows(turn);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.entries[0].text, 'final reasoning');
});

test('a new entry id after a row boundary opens a genuine same-phase reasoning split', () => {
  const harness = createHarness();
  harness.apply(reasoningDelta('p1', 'r1', 'before boundary'));
  harness.apply({ type: 'delta', streamId: STREAM_ID, content: 'Boundary.' }, { segmentText: 'Boundary.' });
  const turn = harness.apply(reasoningDelta('p1', 'r2', 'after boundary', 2));

  assert.deepEqual(turn.events.map((event) => event.kind), [
    'reasoning_phase',
    'assistant_text_segment',
    'reasoning_phase',
  ]);
  assert.deepEqual(turn.rows.map((row) => row.kind), ['reasoning', 'assistant_text', 'reasoning']);
  assert.deepEqual(reasoningRows(turn).map((row) => row.payload.entries.map((entry) => entry.id)), [
    ['r1'],
    ['r2'],
  ]);
});

test('projected retained events preserve live reasoning text for contiguous and interrupted echoes', () => {
  const contiguous = createHarness();
  contiguous.apply(reasoningDelta('p1', 'r1', 'first'));
  const contiguousTurn = contiguous.apply(reasoningDelta('p1', 'r1', 'latest', 1));
  assert.equal(projectedReasoningText(contiguousTurn), reasoningRows(contiguousTurn)[0].payload.entries[0].text);

  const interrupted = createHarness();
  interrupted.apply(reasoningDelta('p1', 'r1', ''));
  interrupted.apply({ type: 'delta', streamId: STREAM_ID, content: 'Boundary.' }, { segmentText: 'Boundary.' });
  const interruptedTurn = interrupted.apply(reasoningDelta('p1', 'r1', 'after boundary', 2));
  assert.equal(projectedReasoningText(interruptedTurn), reasoningRows(interruptedTurn)[0].payload.entries[0].text);
});
