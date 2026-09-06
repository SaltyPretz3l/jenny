const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');

function applyEventSequence(sequence) {
  const state = createTurnReducerState();
  for (let index = 0; index < sequence.length; index += 1) {
    const { payload, context } = sequence[index];
    const events = buildTurnEventFromStreamPayload(payload, {
      turn_id: 'stream-fuzz',
      primary_user_message_id: 'user_fuzz',
      primary_assistant_message_id: 'assistant_stream-fuzz',
      ordinal: index,
      ...context,
    });
    applyTurnStreamEvent(state, events);
  }
  return state.turns_by_id['stream-fuzz'];
}

test('turn reducer tolerates duplicate and oddly ordered live events without exploding row count', () => {
  const turn = applyEventSequence([
    { payload: { type: 'started', streamId: 'stream-fuzz' } },
    {
      payload: {
        type: 'tool_result',
        streamId: 'stream-fuzz',
        callId: 'call-fuzz',
        toolName: 'Read',
        content: 'late result',
        summary: 'late result',
      },
      context: {
        primary_tool_message_id: 'tool_use_call-fuzz',
        tool_result_message_id: 'tool_result_call-fuzz',
      },
    },
    {
      payload: {
        type: 'tool_use',
        streamId: 'stream-fuzz',
        callId: 'call-fuzz',
        toolName: 'Read',
        status: 'running',
        summary: 'Read file',
      },
      context: {
        primary_tool_message_id: 'tool_use_call-fuzz',
      },
    },
    {
      payload: {
        type: 'tool_use',
        streamId: 'stream-fuzz',
        callId: 'call-fuzz',
        toolName: 'Read',
        status: 'running',
        summary: 'Read file',
      },
      context: {
        primary_tool_message_id: 'tool_use_call-fuzz',
      },
    },
    {
      payload: {
        type: 'delta',
        streamId: 'stream-fuzz',
        content: '',
        aggregate: '',
        reasoning: {
          source: 'provider',
          entriesDelta: [{ id: 'reason-1', text: 'Think once.' }],
        },
      },
      context: {
        phase_id: 'phase-fuzz',
        segmentText: '',
      },
    },
    {
      payload: {
        type: 'delta',
        streamId: 'stream-fuzz',
        content: 'Answer',
        aggregate: 'Answer',
      },
      context: {
        phase_id: 'phase-fuzz',
        segmentText: 'Answer',
        segmentIndex: 0,
      },
    },
    {
      payload: {
        type: 'delta',
        streamId: 'stream-fuzz',
        content: 'Answer',
        aggregate: 'Answer',
      },
      context: {
        phase_id: 'phase-fuzz',
        segmentText: 'Answer',
        segmentIndex: 0,
      },
    },
  ]);

  assert.ok(turn);
  // Trace parity (D1): the tool cluster no longer coalesces into one tool_step
  // row. Duplicate tool_use events still collapse onto the single tool_call row
  // (keyed by call id), and the result lives on its own tool_result row — so a
  // de-duped tool turn is exactly one tool_call + one tool_result, never an
  // exploded fan of rows.
  assert.equal(turn.rows.filter((row) => row.kind === 'tool_call').length, 1);
  assert.equal(turn.rows.filter((row) => row.kind === 'tool_result').length, 1);
  assert.equal(turn.rows.filter((row) => row.kind === 'reasoning').length, 1);
  assert.equal(turn.rows.filter((row) => row.kind === 'assistant_text').length, 1);
  // The completed lifecycle now lands on the dedicated tool_result row (the
  // result arrived first in this oddly-ordered sequence), preserving the
  // original "tool reaches completed" intent.
  const toolResultRow = turn.rows.find((row) => row.kind === 'tool_result');
  assert.equal(toolResultRow.payload.state, 'completed');
});

test('turn reducer keeps pathological duplicate streams below the rollout sanity cap', () => {
  const sequence = [{ payload: { type: 'started', streamId: 'stream-fuzz' } }];
  for (let index = 0; index < 20; index += 1) {
    sequence.push({
      payload: {
        type: 'tool_use',
        streamId: 'stream-fuzz',
        callId: 'call-cap',
        toolName: 'Read',
        status: 'running',
        summary: 'Read file',
      },
      context: {
        primary_tool_message_id: 'tool_use_call-cap',
      },
    });
    sequence.push({
      payload: {
        type: 'delta',
        streamId: 'stream-fuzz',
        content: '',
        aggregate: '',
        reasoning: {
          source: 'provider',
          entriesDelta: [{ id: `reason-${index}`, text: `Think ${index}` }],
        },
      },
      context: {
        phase_id: 'phase-cap',
        segmentText: '',
      },
    });
  }

  const turn = applyEventSequence(sequence);

  assert.ok(turn);
  assert.ok(turn.rows.length <= 12, `expected reducer rows to stay below the rollout sanity cap, got ${turn.rows.length}`);
  // Trace parity (D1): the 20 duplicate tool_use events still collapse onto a
  // single tool_call row (keyed by call id), and there is no tool_result event
  // in this stream so no tool_result row is emitted.
  assert.equal(turn.rows.filter((row) => row.kind === 'tool_call').length, 1);
  assert.equal(turn.rows.filter((row) => row.kind === 'tool_result').length, 0);
  assert.equal(turn.rows.filter((row) => row.kind === 'reasoning').length, 1);
});
