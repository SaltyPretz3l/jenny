const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, createQueuedFrameController } = require('./helpers/renderer-stream-handler-harness');

// Content deltas must accumulate into the visible chunk even when a
// thinking_status precedes them mid-stream.
test('content deltas accumulate after a thinking_status', async (t) => {
  const frames = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-p3-acc' });
  await harness.emit({ type: 'thinking_status', sessionId: 'session-1', streamId: 'stream-p3-acc', text: 'planning' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-p3-acc',
    content: 'A',
    aggregate: 'A',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-p3-acc',
    content: 'B',
    aggregate: 'AB',
  });
  await frames.drainNextFrame();

  const messages = harness.state.messagesBySession.get('session-1');
  const pending = messages.find((message) => message.streamId === 'stream-p3-acc');
  assert.ok(pending, 'pending stream entry is created');
  assert.equal(pending.content, 'AB');
});

// Explicit callIds keep concurrent tool_use entries from cross-binding: a
// tool_result carrying its own callId must pair with the matching tool_use
// even when an older tool_use is still open.
test('explicit callIds keep parallel tool_use entries paired correctly', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-p6b' });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-p6b',
    callId: 'call-A',
    toolName: 'Read',
    status: 'running',
    summary: 'reading A',
  });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-p6b',
    callId: 'call-B',
    toolName: 'Read',
    status: 'running',
    summary: 'reading B',
  });
  // Result for B arrives first with its explicit callId; must NOT bind
  // to A even though A is older.
  await harness.emit({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-p6b',
    callId: 'call-B',
    toolName: 'Read',
    content: 'B done',
    summary: 'B',
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const useA = messages.find((m) => m.kind === 'tool_use' && m.tool_call?.call_id === 'call-A');
  const useB = messages.find((m) => m.kind === 'tool_use' && m.tool_call?.call_id === 'call-B');
  const resultB = messages.find((m) => m.kind === 'tool_result' && m.tool_result?.call_id === 'call-B');
  assert.equal(useA.tool_call.status, 'running');
  assert.equal(useB.tool_call.status, 'completed');
  assert.ok(resultB, 'tool_result paired with B');
});

// Phase 10C P.5 — the stream handler exposes a rehydrate API that seeds
// live reducer state from persisted turn_events[] when row-model is
// enabled for a session. Used by the lifecycle controller after each
// setSessionTurnEventState call.
test('Phase 10C P.5: rehydrateSessionFromPersistedTurnEvents seeds live state when row-model is on', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);
  if (!(harness.state.turnEventsBySession instanceof Map)) {
    harness.state.turnEventsBySession = new Map();
  }
  harness.state.turnEventsBySession.set('session-1', {
    turnEventLogVersion: 1,
    turnEvents: [
      {
        event_id: 'e:tu',
        turn_id: 'remount-turn',
        kind: 'tool_use',
        primary_message_id: 'tool_use_remount-call',
        source_message_ids: ['tool_use_remount-call'],
        tool_call_id: 'remount-call',
        payload: { tool_name: 'Read', input: {}, summary: 'reading' },
      },
      {
        event_id: 'e:tr',
        turn_id: 'remount-turn',
        kind: 'tool_result',
        primary_message_id: 'tool_use_remount-call',
        source_message_ids: ['tool_use_remount-call', 'tool_result_remount-call'],
        tool_call_id: 'remount-call',
        payload: { tool_name: 'Read', output_text: 'ok', summary: 'read' },
      },
    ],
  });

  const seeded = harness.handler.rehydrateSessionFromPersistedTurnEvents('session-1');
  assert.ok(seeded, 'rehydration returns the seeded reducer state');
  const liveStore = harness.state.ui.chatTimelineLiveStateBySession;
  assert.ok(liveStore instanceof Map);
  const liveState = liveStore.get('session-1');
  assert.ok(liveState, 'live state populated for session');
  const turn = liveState.turns_by_id['remount-turn'];
  assert.ok(turn, 'remount turn rehydrated');
  // Trace parity (D1): a completed tool rehydrates into a tool_call row plus a
  // separate, adjacent tool_result row (no compact coalescing). Both share the
  // call id; the call/state lives on tool_call, the result content on
  // tool_result.
  assert.equal(turn.rows.length, 2);
  const callRow = turn.rows[0];
  const resultRow = turn.rows[1];
  assert.equal(callRow.kind, 'tool_call');
  assert.equal(callRow.tool_call_id, 'remount-call');
  assert.equal(callRow.payload.state, 'completed');
  assert.equal(resultRow.kind, 'tool_result');
  assert.equal(resultRow.tool_call_id, 'remount-call');
  assert.equal(resultRow.payload.state, 'completed');
  assert.equal(resultRow.payload.output_text, 'ok');
});

// Phase 10C P.5 — rehydration must be a no-op when row-model is off,
// preserving the legacy path's behaviour.
test('Phase 10C P.5: rehydrate is a no-op when row-model is disabled', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  if (!(harness.state.turnEventsBySession instanceof Map)) {
    harness.state.turnEventsBySession = new Map();
  }
  harness.state.turnEventsBySession.set('session-2', {
    turnEventLogVersion: 1,
    turnEvents: [
      {
        event_id: 'e:tu',
        turn_id: 'remount-turn-2',
        kind: 'tool_use',
        primary_message_id: 'tool_use_x',
        source_message_ids: ['tool_use_x'],
        tool_call_id: 'x',
        payload: { tool_name: 'Read' },
      },
    ],
  });
  const seeded = harness.handler.rehydrateSessionFromPersistedTurnEvents('session-2');
  assert.equal(seeded, null, 'no live state when row-model is off');
});
