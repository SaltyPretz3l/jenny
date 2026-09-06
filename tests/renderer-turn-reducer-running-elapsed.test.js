// Sibling of tests/renderer-turn-reducer.test.js (that file sits at the
// file-size cap): pins the running_started_at_ms stamp the per-tool elapsed
// timer ticks from (renderer-turn-row-tool-render-utils elapsed node +
// renderer-turn-elapsed-clock [data-turn-elapsed] scan).
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
    turn_id: 'stream-elapsed',
    primary_user_message_id: 'user_elapsed',
    primary_assistant_message_id: 'assistant_stream-elapsed',
    ordinal: state.__testOrdinal,
    ...context,
  });
  state.__testOrdinal += 1;
  applyTurnStreamEvent(state, events);
  return state.turns_by_id['stream-elapsed'];
}

function toolRow(turn) {
  return turn.rows.find((row) => row.kind === 'tool_call');
}

test('running tool_use stamps running_started_at_ms once and keeps the anchor', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-elapsed' });
  const before = Date.now();
  const turn = applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-elapsed',
    callId: 'call-run',
    toolName: 'run_command',
    status: 'running',
    summary: 'npm test',
  }, { primary_tool_message_id: 'tool_use_call-run' });
  const after = Date.now();

  const payload = toolRow(turn).payload;
  assert.equal(payload.state, 'running');
  assert.ok(Number.isFinite(payload.running_started_at_ms));
  assert.ok(payload.running_started_at_ms >= before && payload.running_started_at_ms <= after);

  // A duplicate/late running event must not restamp the anchor: the timer
  // would visibly reset mid-run.
  const firstStamp = payload.running_started_at_ms;
  payload.running_started_at_ms = 123456; // sentinel: any restamp overwrites this
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-elapsed',
    callId: 'call-run',
    toolName: 'run_command',
    status: 'running',
    summary: 'npm test',
  }, { primary_tool_message_id: 'tool_use_call-run' });
  assert.equal(toolRow(turn).payload.running_started_at_ms, 123456);
  assert.ok(firstStamp <= after);
});

test('awaiting_approval does not stamp a running anchor', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-elapsed' });
  const turn = applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-elapsed',
    callId: 'call-gate',
    toolName: 'run_command',
    status: 'pending_approval',
    summary: 'rm -rf build',
  }, { primary_tool_message_id: 'tool_use_call-gate' });

  const payload = toolRow(turn).payload;
  assert.equal(payload.state, 'awaiting_approval');
  assert.equal(payload.running_started_at_ms, undefined);
  // The approval anchor (pre-existing contract) still stamps.
  assert.ok(Number.isFinite(payload.approval_requested_at_ms));
});
