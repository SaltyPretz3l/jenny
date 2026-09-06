const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');

function applyPayload(state, payload) {
  state.testOrdinal = Number(state.testOrdinal || 0);
  const event = buildTurnEventFromStreamPayload(payload, {
    turn_id: 'stream-terminal',
    primary_user_message_id: 'user-terminal',
    primary_assistant_message_id: 'assistant-terminal',
    event_id: `terminal-${state.testOrdinal}`,
    ordinal: state.testOrdinal,
  });
  state.testOrdinal += 1;
  applyTurnStreamEvent(state, event);
  return state.turns_by_id['stream-terminal'];
}

test('reducer preserves every canonical terminal presentation', () => {
  const cases = [
    ['complete', undefined, 'completed'],
    ['error', 'error', 'errored'],
    ['error', 'cancelled', 'cancelled'],
    ['error', 'denied', 'denied'],
    ['error', 'timeout', 'timed_out'],
    ['error', 'interrupted', 'interrupted'],
    ['error', 'preempted', 'preempted'],
    ['error', 'malformed', 'unknown'],
  ];
  for (const [type, terminalStatus, expected] of cases) {
    const state = createTurnReducerState();
    const turn = applyPayload(state, { type, streamId: 'stream-terminal', terminal_status: terminalStatus });
    assert.equal(turn.status, expected);
  }
});

test('reducer ignores late and duplicate terminals after the first settlement', () => {
  const state = createTurnReducerState();
  const turn = applyPayload(state, { type: 'error', streamId: 'stream-terminal', terminal_status: 'timeout' });
  const rowCount = turn.rows.length;
  applyPayload(state, { type: 'complete', streamId: 'stream-terminal' });
  assert.equal(turn.status, 'timed_out');
  assert.equal(turn.rows.length, rowCount);
  assert.equal(turn.ignored_terminal_event_count, 1);
  assert.equal(turn.last_ignored_terminal_reason, 'late');

  const duplicate = buildTurnEventFromStreamPayload(
    { type: 'error', streamId: 'stream-terminal', terminal_status: 'timeout' },
    { turn_id: 'stream-terminal', event_id: 'terminal-0' }
  );
  applyTurnStreamEvent(state, duplicate);
  assert.equal(turn.ignored_terminal_event_count, 2);
  assert.equal(turn.last_ignored_terminal_reason, 'duplicate');
});
