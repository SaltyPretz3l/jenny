// Sibling of tests/renderer-turn-reducer.test.js (that file sits at the
// file-size cap): pins the reducer's synthetic live reasoning phase fallback.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');

function applyPayload(state, payload, context = {}) {
  state.__testOrdinal = Number(state.__testOrdinal || 0);
  const events = buildTurnEventFromStreamPayload(payload, {
    turn_id: 'stream-live-phase',
    primary_user_message_id: 'user_live-phase',
    primary_assistant_message_id: 'assistant_stream-live-phase',
    ordinal: state.__testOrdinal,
    ...context,
  });
  state.__testOrdinal += 1;
  applyTurnStreamEvent(state, events);
  return state.turns_by_id['stream-live-phase'];
}

test('reducer opens a new reasoning row per segment when no phase id is provided', () => {
  // 2026-07-17 vanish RCA: local providers send reasoning deltas with NO
  // phaseId/thinkingId, so every segment fell into the synthetic fallback —
  // which was stream-global. All reasoning then merged into the turn's FIRST
  // reasoning row, hoisting the live thinking + answer to the top of the turn
  // mid-stream ("everything disappears, pops back at settle"). The fallback
  // must advance with the per-segment assistant shell message id.
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-live-phase' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'phase one' }] },
  });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-live-phase',
    callId: 'call-1',
    toolName: 'read_file',
    status: 'running',
  }, { primary_tool_message_id: 'tool_use_call-1' });
  applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-live-phase',
    callId: 'call-1',
    toolName: 'read_file',
    content: 'ok',
  }, { primary_tool_message_id: 'tool_use_call-1', tool_result_message_id: 'tool_result_call-1' });
  applyPayload(state, { type: 'stream_reset', streamId: 'stream-live-phase', reason: 'tool_continuation' });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r2', text: 'phase two' }] },
  }, { primary_assistant_message_id: 'assistant_stream-live-phase_seg1', segmentIndex: 1 });

  const reasoningRows = turn.rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 2, 'each segment opens its own reasoning row');
  assert.deepEqual(reasoningRows[0].payload.entries.map((entry) => entry.id), ['r1']);
  assert.deepEqual(reasoningRows[1].payload.entries.map((entry) => entry.id), ['r2']);
  const kinds = turn.rows.map((row) => row.kind);
  assert.ok(
    kinds.indexOf('tool_result') < kinds.lastIndexOf('reasoning'),
    'the continuation reasoning row appends after the tool rows, not into the turn top'
  );
});

test('reducer gives phase-distinct reasoning rows unique deterministic identities when thinking ids repeat', () => {
  const state = createTurnReducerState({ deterministicRowId: true });
  applyPayload(state, { type: 'started', streamId: 'stream-live-phase' });

  applyPayload(state, {
    type: 'phase_started',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reasoning_1',
    phaseKind: 'reasoning',
    thinkingId: 'think_shared',
  });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reasoning_1',
    thinkingId: 'think_shared',
    phase: { phase_id: 'phase_reasoning_1', phase_kind: 'reasoning', thinking_id: 'think_shared' },
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'first phase' }] },
  });
  applyPayload(state, {
    type: 'phase_completed',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reasoning_1',
    phaseKind: 'reasoning',
    thinkingId: 'think_shared',
  });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    content: 'A short visible preamble.',
  }, { segmentText: 'A short visible preamble.' });
  applyPayload(state, {
    type: 'phase_started',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reasoning_2',
    phaseKind: 'reasoning',
    thinkingId: 'think_shared',
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reasoning_2',
    thinkingId: 'think_shared',
    phase: { phase_id: 'phase_reasoning_2', phase_kind: 'reasoning', thinking_id: 'think_shared' },
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r2', text: 'second phase' }] },
  });

  const reasoningRows = turn.rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 2);
  assert.deepEqual(
    reasoningRows.map((row) => row.row_id),
    [
      'row:reasoning:stream-live-phase:phase_reasoning_1',
      'row:reasoning:stream-live-phase:phase_reasoning_2',
    ],
  );
});

test('reducer opens a new live row when a tool boundary reuses the same reasoning phase id', () => {
  const state = createTurnReducerState({ deterministicRowId: true });
  applyPayload(state, { type: 'started', streamId: 'stream-live-phase' });
  applyPayload(state, {
    type: 'phase_started',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reused',
    phaseKind: 'reasoning',
    thinkingId: 'thinking_reused',
  });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reused',
    thinkingId: 'thinking_reused',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'before tool' }] },
  });
  applyPayload(state, {
    type: 'phase_completed',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reused',
    phaseKind: 'reasoning',
    thinkingId: 'thinking_reused',
  });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-live-phase',
    callId: 'call-reused-phase',
    toolName: 'read_file',
    status: 'running',
  }, { primary_tool_message_id: 'tool_use_call-reused-phase' });
  applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-live-phase',
    callId: 'call-reused-phase',
    toolName: 'read_file',
    content: 'ok',
  }, {
    primary_tool_message_id: 'tool_use_call-reused-phase',
    tool_result_message_id: 'tool_result_call-reused-phase',
  });
  applyPayload(state, {
    type: 'phase_started',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reused',
    phaseKind: 'reasoning',
    thinkingId: 'thinking_reused',
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    phaseId: 'phase_reused',
    thinkingId: 'thinking_reused',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r2', text: 'after tool' }] },
  });

  const reasoningRows = turn.rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 2);
  assert.deepEqual(reasoningRows.map((row) => row.payload.entries.map((entry) => entry.text)), [
    ['before tool'],
    ['after tool'],
  ]);
  assert.deepEqual(reasoningRows.map((row) => row.row_id), [
    'row:reasoning:stream-live-phase:phase_reused',
    'row:reasoning:stream-live-phase:phase_reused#1',
  ]);
  assert.ok(
    turn.rows.findIndex((row) => row.kind === 'tool_result') < turn.rows.lastIndexOf(reasoningRows[1]),
    'the reused phase resumes after the tool rows instead of mutating the pre-tool row'
  );
});

test('reducer settles a reasoning row when phase completion has no summary', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-live-phase' });
  applyPayload(state, {
    type: 'phase_started',
    streamId: 'stream-live-phase',
    phaseId: 'phase_empty_summary',
    phaseKind: 'reasoning',
    thinkingId: 'think_empty_summary',
  });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    phaseId: 'phase_empty_summary',
    thinkingId: 'think_empty_summary',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'working' }] },
  });
  const turn = applyPayload(state, {
    type: 'phase_completed',
    streamId: 'stream-live-phase',
    phaseId: 'phase_empty_summary',
    phaseKind: 'reasoning',
    thinkingId: 'think_empty_summary',
    summary: '',
  });

  const row = turn.rows.find((candidate) => candidate.kind === 'reasoning');
  assert.equal(row?.payload?.completed, true);
});

test('reducer marks reflexive_retry output as restarted', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-live-phase' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    content: 'Discarded malformed tool attempt.',
    aggregate: 'Discarded malformed tool attempt.',
  }, {
    segmentText: 'Discarded malformed tool attempt.',
    segmentIndex: 0,
  });
  applyPayload(state, {
    type: 'stream_reset',
    streamId: 'stream-live-phase',
    reason: 'reflexive_retry',
  }, {
    primary_assistant_message_id: 'assistant_stream-live-phase',
    next_assistant_message_id: 'assistant_stream-live-phase_seg1',
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-live-phase',
    content: 'Corrected response.',
    aggregate: 'Corrected response.',
  }, {
    primary_assistant_message_id: 'assistant_stream-live-phase_seg1',
    segmentText: 'Corrected response.',
    segmentIndex: 1,
  });

  assert.equal(turn.rows[0].payload.truncated, true);
});

test('error translation carries the cancellation classification through to the reducer', () => {
  // GUI finding 2026-07-20: buildTurnEventFromStreamPayload dropped the
  // terminal classification, so a user Stop settled the deck as errored
  // ("Needs Recovery") instead of cancelled.
  const event = buildTurnEventFromStreamPayload(
    { type: 'error', streamId: 'stream-live-phase', status: 'cancelled', terminal_subcode: 'user_stop' },
    { turn_id: 'stream-live-phase', ordinal: 90 },
  );
  assert.equal(event.terminal_status, 'cancelled');

  const generic = buildTurnEventFromStreamPayload(
    { type: 'error', streamId: 'stream-live-phase', status: 'error' },
    { turn_id: 'stream-live-phase', ordinal: 91 },
  );
  assert.equal(generic.terminal_status, 'errored', 'the canonical terminal matrix classifies generic errors');
});

test('reducer stamps a cancelled status when the error event is classified as a cancellation', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-live-phase' });
  const turn = applyPayload(state, {
    type: 'error', streamId: 'stream-live-phase', status: 'cancelled', terminal_subcode: 'user_stop',
  });
  assert.equal(turn.status, 'cancelled');
});

test('reducer keeps errored status for unclassified error events', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-live-phase' });
  const turn = applyPayload(state, { type: 'error', streamId: 'stream-live-phase' });
  assert.equal(turn.status, 'errored');
});
