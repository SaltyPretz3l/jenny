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

test('stream handler subscribes to exactly the V2 envelope path when stream envelope v2 is enabled', async (t) => {
  const harness = createHarness({
    stateOverrides: {
      features: {
        featureFlags: {
          stream_envelope_v2: true,
        },
      },
    },
  });
  t.after(() => harness.restore());

  assert.equal(harness.streamSubscriptions.legacy, 0);
  assert.equal(harness.streamSubscriptions.envelope, 1);

  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-envelope-1',
    turnId: 'stream-envelope-1',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });
  await harness.emitEnvelope({
    eventKind: 'delta',
    channel: 'response',
    streamId: 'stream-envelope-1',
    turnId: 'stream-envelope-1',
    sessionId: 'session-1',
    sequence: 1,
    channelSequence: 1,
    phase: { phaseId: 'phase_text_1', phaseKind: 'text', iteration: 1 },
    payload: { delta: 'Hello from V2' },
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.content, 'Hello from V2');
});

test('stream handler keeps V2 reasoning deltas out of visible answer content', async (t) => {
  const harness = createHarness({
    stateOverrides: {
      features: {
        featureFlags: {
          stream_envelope_v2: true,
        },
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-envelope-reasoning',
    turnId: 'turn-envelope-reasoning',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });
  await harness.emitEnvelope({
    eventKind: 'delta',
    channel: 'reasoning',
    streamId: 'stream-envelope-reasoning',
    turnId: 'turn-envelope-reasoning',
    sessionId: 'session-1',
    sequence: 1,
    channelSequence: 1,
    phase: { phaseId: 'phase_reasoning_1', phaseKind: 'reasoning', iteration: 1 },
    payload: {
      delta: 'Private reasoning delta',
      summary: 'Provider supplied summary',
    },
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.content, '');
  assert.equal(assistant.reasoning.source, 'provider');
  assert.equal(assistant.reasoning.entries[0].text, 'Private reasoning delta');
});

test('stream handler skips malformed V2 envelopes with bounded diagnostics', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      features: {
        featureFlags: {
          stream_envelope_v2: true,
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    eventKind: 'delta',
    channel: 'response',
    sessionId: 'session-1',
    payload: { delta: 'missing stream id' },
  });

  assert.equal(harness.state.messagesBySession.get('session-1').length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].eventName, 'stream.envelope_v2_invalid');
  assert.equal(logs[0].details.channel, 'response');
});

test('V2 terminal handler failures emit a stream fault and never a terminal receipt', async (t) => {
  const records = [];
  const messagesBySession = new Map([['session-1', []]]);
  const harness = createHarness({
    stateOverrides: {
      messagesBySession,
      features: { featureFlags: { stream_envelope_v2: true } },
      window: {
        jennyShell: {
          chat: { ackEnvelopeReceipt(record) { records.push(record); return { ok: true }; } },
          sessions: { async getMessages() { return { data: [] }; } },
        },
      },
    },
    callbackOverrides: {
      setSessionMessages(sessionId, messages) {
        if (messages.some((message) => message?.status === 'complete')) {
          throw new Error('terminal renderer mutation failed');
        }
        messagesBySession.set(sessionId, messages);
      },
    },
  });
  t.after(() => harness.restore());
  records.length = 0;

  await harness.emitEnvelope({
    eventKind: 'started', channel: 'control', streamId: 'stream-handler-fault',
    turnId: 'turn-handler-fault', sessionId: 'session-1', payload: { type: 'started' },
  });
  await harness.emitEnvelope({
    eventKind: 'terminal', channel: 'control', streamId: 'stream-handler-fault',
    turnId: 'turn-handler-fault', sessionId: 'session-1', sequence: 1, channelSequence: 1,
    payload: { type: 'complete', content: 'done' },
  });

  assert.equal(records.some((record) => record.recordType === 'stream_fault'), true);
  assert.equal(records.some((record) => record.recordType === 'terminal_receipt'), false);
});

test('malformed V2 envelopes do not poison sequence or receipt accounting', async (t) => {
  const logs = [];
  const acks = [];
  const harness = createHarness({
    stateOverrides: {
      features: {
        featureFlags: {
          stream_envelope_v2: true,
        },
      },
      window: {
        jennyShell: {
          chat: {
            ackEnvelopeReceipt(record) {
              acks.push(record);
              return null;
            },
          },
          sessions: {
            async getMessages() {
              return { data: [] };
            },
          },
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-envelope-invalid-seq',
    turnId: 'turn-envelope-invalid-seq',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });
  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'unsupported',
    channel: 'response',
    streamId: 'stream-envelope-invalid-seq',
    turnId: 'turn-envelope-invalid-seq',
    sessionId: 'session-1',
    sequence: 50,
    channelSequence: 50,
    payload: { delta: 'bad envelope' },
  });
  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'delta',
    channel: 'response',
    streamId: 'stream-envelope-invalid-seq',
    turnId: 'turn-envelope-invalid-seq',
    sessionId: 'session-1',
    sequence: 1,
    channelSequence: 1,
    payload: { delta: 'Hello' },
  });
  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'terminal',
    channel: 'control',
    streamId: 'stream-envelope-invalid-seq',
    turnId: 'turn-envelope-invalid-seq',
    sessionId: 'session-1',
    sequence: 2,
    channelSequence: 1,
    payload: { type: 'complete' },
  });

  const assistant = harness.state.messagesBySession
    .get('session-1')
    .find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.content, 'Hello');
  assert.deepEqual(acks, [
    { recordType: 'subscription_started', rendererEpoch: 2, mode: 'envelope' },
    {
      recordType: 'terminal_receipt',
      rendererEpoch: 2,
      streamId: 'stream-envelope-invalid-seq',
      session_id: 'session-1',
      turn_id: 'turn-envelope-invalid-seq',
      receivedCount: 3,
      sequenceStart: 1,
      sequenceEnd: 2,
      channels: {
        control: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
        response: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
      },
      terminalType: 'complete',
      eventKind: 'terminal',
    },
  ]);
  assert.equal(
    logs.some((entry) => entry.eventName === 'stream.envelope_v2_invalid'),
    true
  );
  assert.equal(
    logs.some((entry) => entry.eventName === 'stream.envelope_v2_sequence_regression'),
    false
  );
});

test('stream handler drops regressing V2 envelopes for the same stream', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      features: {
        featureFlags: {
          stream_envelope_v2: true,
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-envelope-regress',
    turnId: 'turn-envelope-regress',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });
  await harness.emitEnvelope({
    eventKind: 'delta',
    channel: 'response',
    streamId: 'stream-envelope-regress',
    turnId: 'turn-envelope-regress',
    sessionId: 'session-1',
    sequence: 1,
    channelSequence: 1,
    phase: { phaseId: 'phase_text_1', phaseKind: 'text', iteration: 1 },
    payload: { delta: 'Fresh' },
  });
  await harness.emitEnvelope({
    eventKind: 'delta',
    channel: 'response',
    streamId: 'stream-envelope-regress',
    turnId: 'turn-envelope-regress',
    sessionId: 'session-1',
    sequence: 1,
    channelSequence: 2,
    phase: { phaseId: 'phase_text_1', phaseKind: 'text', iteration: 1 },
    payload: { delta: ' stale' },
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.content, 'Fresh');
  const regressionLog = logs.find((entry) => entry.eventName === 'stream.envelope_v2_sequence_regression');
  assert.ok(regressionLog);
  assert.equal(regressionLog.level, 'WARN');
  assert.equal(regressionLog.details.streamId, 'stream-envelope-regress');
});

test('envelope sequence faults switch the live subscription to legacy recovery', async (t) => {
  const harness = createHarness({
    stateOverrides: {
      features: { featureFlags: { stream_envelope_v2: true } },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    schemaVersion: 2, eventKind: 'started', channel: 'control',
    streamId: 'stream-reload-gap', turnId: 'turn-reload-gap', sessionId: 'session-1',
    payload: { type: 'started' },
  });
  await harness.emitEnvelope({
    schemaVersion: 2, eventKind: 'delta', channel: 'response',
    streamId: 'stream-reload-gap', turnId: 'turn-reload-gap', sessionId: 'session-1',
    sequence: 3, channelSequence: 1, payload: { delta: 'lost suffix' },
  });
  assert.equal(harness.streamSubscriptions.envelope, 1);
  assert.equal(harness.streamSubscriptions.legacy, 1);

  await harness.emit({
    type: 'delta', streamId: 'stream-reload-gap', turnId: 'turn-reload-gap',
    sessionId: 'session-1', content: 'Recovered', aggregate: 'Recovered',
  });
  const assistant = harness.state.messagesBySession.get('session-1')
    .find((message) => message.role === 'assistant');
  assert.equal(assistant.content, 'Recovered');
});
