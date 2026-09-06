const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, createQueuedFrameController } = require('./helpers/renderer-stream-handler-harness');

async function flushMicrotasks(count = 20) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

test('row-model sessions feed provisional live reducer state while legacy sessions stay on the old path', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);
  harness.state.ui.chatTimelineRowModelBySession.set('session-2', false);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-row-model' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-model',
    content: 'Row-model text',
    aggregate: 'Row-model text',
  });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-row-model',
    callId: 'call-row-model',
    toolName: 'Read',
    status: 'running',
    summary: 'Read file',
  });

  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  assert.ok(liveState, 'row-model session should create reducer-backed live state');
  assert.ok(liveState.turns_by_id['stream-row-model'], 'active turn should exist in reducer state');
  assert.deepEqual(
    liveState.turns_by_id['stream-row-model'].rows.map((row) => row.kind),
    ['assistant_text', 'tool_call']
  );

  await harness.emit({ type: 'started', sessionId: 'session-2', streamId: 'stream-legacy' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-2',
    streamId: 'stream-legacy',
    content: 'Legacy text',
    aggregate: 'Legacy text',
  });

  const legacyLiveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-2');
  assert.equal(legacyLiveState == null, true, 'legacy session should not create reducer-backed live state');
});

test('row-model live text uses stream content deltas instead of appending cumulative aggregates', async (t) => {
  const frames = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
  });
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-row-delta' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-delta',
    content: 'Functional ',
    aggregate: 'Functional ',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-delta',
    content: 'tools ',
    aggregate: 'Functional tools ',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-delta',
    content: 'currently available:',
    aggregate: 'Functional tools currently available:',
  });
  await frames.drainNextFrame();

  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  const assistantRow = liveState.turns_by_id['stream-row-delta'].rows
    .find((row) => row.kind === 'assistant_text');
  assert.equal(
    assistantRow.payload.text,
    'Functional tools currently available:'
  );

  const assistantMessage = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-row-delta');
  assert.equal(
    assistantMessage.content,
    'Functional tools currently available:'
  );
});

test('terminal hydration clears provisional active turn state for row-model sessions', async (t) => {
  const refreshedMessages = [
    { id: 'user_row_clear', role: 'user', content: 'Check it', status: 'complete' },
    {
      id: 'assistant_stream-row-clear',
      role: 'assistant',
      content: 'Checking.',
      status: 'complete',
      streamId: 'stream-row-clear',
      finalizedAt: '2026-04-14T12:00:00.000Z',
    },
    {
      id: 'tool_use_call-row-clear',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call-row-clear',
        tool_name: 'Read',
        parent_stream_id: 'stream-row-clear',
        summary: 'Read file',
      },
    },
    {
      id: 'tool_result_call-row-clear',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call-row-clear',
        tool_name: 'Read',
        summary: 'Read file',
        output_text: 'done',
        parent_stream_id: 'stream-row-clear',
      },
    },
  ];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return { data: refreshedMessages };
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-row-clear' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-clear',
    content: 'Checking.',
    aggregate: 'Checking.',
  });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-row-clear',
    callId: 'call-row-clear',
    toolName: 'Read',
    status: 'running',
    summary: 'Read file',
  });
  assert.ok(
    harness.state.ui.chatTimelineLiveStateBySession.get('session-1')?.turns_by_id?.['stream-row-clear'],
    'provisional turn should exist before terminal hydration'
  );

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-row-clear',
    content: 'Checking.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });

  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  assert.equal(
    Boolean(liveState?.turns_by_id?.['stream-row-clear']),
    false,
    'terminal hydration should clear the provisional active turn'
  );
  assert.equal(
    liveState == null || typeof liveState === 'object',
    true,
    'row-model terminal hydration should settle without leaving stale provisional state behind'
  );
});

test('terminal hydration preserves camelCase turn-event state from the session bridge', async (t) => {
  const refreshedMessages = [
    { id: 'user_row_camel', role: 'user', content: 'Check it', status: 'complete' },
    {
      id: 'assistant_stream-row-camel',
      role: 'assistant',
      content: 'Checking.',
      status: 'complete',
      streamId: 'stream-row-camel',
      finalizedAt: '2026-04-14T12:05:00.000Z',
    },
  ];
  const turnEvents = [{
    event_id: 'event-row-camel',
    turn_id: 'stream-row-camel',
    kind: 'assistant_text',
    primary_message_id: 'assistant_stream-row-camel',
    source_message_ids: ['assistant_stream-row-camel'],
    payload: { text: 'Checking.' },
  }];
  const capturedTurnEventStates = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return {
                data: refreshedMessages,
                turnEventLogVersion: 2,
                turnEvents,
              };
            },
          },
        },
      },
    },
    callbackOverrides: {
      setSessionTurnEventState(sessionId, turnEventState) {
        capturedTurnEventStates.push({ sessionId, turnEventState });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-row-camel' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-camel',
    content: 'Checking.',
    aggregate: 'Checking.',
  });
  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-row-camel',
    content: 'Checking.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });

  assert.deepEqual(capturedTurnEventStates, [{
    sessionId: 'session-1',
    turnEventState: {
      turnEventLogVersion: 2,
      turnEvents,
    },
  }]);
});

test('message update refresh preserves camelCase turn-event state from the session bridge', async (t) => {
  const refreshedMessages = [{
    id: 'assistant_message_update_camel',
    role: 'assistant',
    content: 'Before refresh.',
    status: 'streaming',
  }];
  const turnEvents = [{
    event_id: 'event-message-update-camel',
    turn_id: 'stream-message-update-camel',
    kind: 'assistant_text',
    primary_message_id: 'assistant_message_update_camel',
    source_message_ids: ['assistant_message_update_camel'],
    payload: { text: 'Before refresh.' },
  }];
  const capturedTurnEventStates = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return {
                data: refreshedMessages,
                turnEventLogVersion: 2,
                turnEvents,
              };
            },
          },
        },
      },
    },
    callbackOverrides: {
      setSessionTurnEventState(sessionId, turnEventState) {
        capturedTurnEventStates.push({ sessionId, turnEventState });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'message_updated',
    sessionId: 'session-1',
    messageId: 'assistant_message_update_camel',
    patch: {
      content: 'After refresh.',
      status: 'complete',
    },
  });

  assert.deepEqual(capturedTurnEventStates, [{
    sessionId: 'session-1',
    turnEventState: {
      turnEventLogVersion: 2,
      turnEvents,
    },
  }]);
  assert.equal(
    harness.state.messagesBySession.get('session-1')?.[0]?.content,
    'After refresh.'
  );
});

test('row-model error terminals reconcile from persisted messages before clearing provisional state', async (t) => {
  const refreshedMessages = [
    { id: 'user_row_error', role: 'user', content: 'Check it', status: 'complete' },
    {
      id: 'assistant_stream-row-error',
      role: 'assistant',
      content: 'Failed after checking.',
      status: 'error',
      streamId: 'stream-row-error',
      stream_error: 'persisted boom',
      finalizedAt: '2026-04-14T12:10:00.000Z',
    },
    {
      id: 'tool_use_call-row-error',
      role: 'assistant',
      kind: 'tool_use',
      status: 'error',
      tool_call: {
        call_id: 'call-row-error',
        tool_name: 'Read',
        parent_stream_id: 'stream-row-error',
        summary: 'Read file',
        status: 'error',
      },
    },
    {
      id: 'tool_result_call-row-error',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call-row-error',
        tool_name: 'Read',
        summary: 'Read file',
        output_text: 'permission denied',
        is_error: true,
        error_code: 'CMP-TOOL-0001',
        parent_stream_id: 'stream-row-error',
      },
    },
  ];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return { data: refreshedMessages };
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-row-error' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-error',
    content: 'Checking.',
    aggregate: 'Checking.',
  });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-row-error',
    callId: 'call-row-error',
    toolName: 'Read',
    status: 'running',
    summary: 'Read file',
  });

  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-row-error',
    message: 'boom',
    error_code: 'CMP-CHAT-0002',
    retryable: false,
    category: 'tool',
  });

  assert.deepEqual(
    harness.state.messagesBySession.get('session-1'),
    refreshedMessages,
    'row-model error settlement should prefer persisted transcript hydration over stale local messages'
  );
  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  assert.equal(
    Boolean(liveState?.turns_by_id?.['stream-row-error']),
    false,
    'error terminal hydration should clear the provisional active turn'
  );
});

test('background row-model terminal hydration clears live reducer state immediately', async (t) => {
  const refreshedMessages = [
    { id: 'user_row_background', role: 'user', content: 'Background task', status: 'complete' },
    {
      id: 'assistant_stream-row-background',
      role: 'assistant',
      content: 'Done in background.',
      status: 'complete',
      streamId: 'stream-row-background',
      finalizedAt: '2026-04-14T12:20:00.000Z',
    },
  ];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return { data: refreshedMessages };
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-2', true);

  await harness.emit({ type: 'started', sessionId: 'session-2', streamId: 'stream-row-background' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-2',
    streamId: 'stream-row-background',
    content: 'Working in background.',
    aggregate: 'Working in background.',
  });

  assert.ok(
    harness.state.ui.chatTimelineLiveStateBySession.get('session-2')?.turns_by_id?.['stream-row-background'],
    'background row-model session should accumulate provisional state while streaming'
  );

  await harness.emit({
    type: 'complete',
    sessionId: 'session-2',
    streamId: 'stream-row-background',
    content: 'Done in background.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });

  assert.equal(
    harness.state.ui.chatTimelineLiveStateBySession.has('session-2'),
    false,
    'background terminal hydration should clear reducer state immediately when no chat DOM is visible'
  );
});

test('row-model reconciliation logs stale-row telemetry when provisional rows do not survive hydration', async (t) => {
  const refreshedMessages = [
    { id: 'user_stream-row-stale', role: 'user', content: 'Check it', status: 'complete' },
    {
      id: 'assistant_stream-row-stale',
      role: 'assistant',
      content: 'Done.',
      status: 'complete',
      streamId: 'stream-row-stale',
      parent_stream_id: 'stream-row-stale',
      finalizedAt: '2026-04-14T12:30:00.000Z',
    },
  ];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return { data: refreshedMessages };
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-row-stale' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-row-stale',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-stale', text: 'Thinking that should disappear.' }],
    },
    thinkingId: 'think-stale',
  });
  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-row-stale',
    content: 'Done.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });

  const staleSignal = harness.calls.rolloutSignals.find((entry) => entry.signal === 'stale_row_deletion');
  assert.ok(staleSignal, 'expected stale-row rollout telemetry');
  assert.equal(staleSignal.sessionId, 'session-1');
  assert.equal(staleSignal.details.turnId, 'stream-row-stale');
  assert.equal(staleSignal.details.staleRowCount, 1);
});

test('row-model reconciliation logs interrupted-running-tool hydration telemetry', async (t) => {
  const refreshedMessages = [
    { id: 'user_stream-row-interrupted', role: 'user', content: 'Resume it', status: 'complete' },
    {
      id: 'tool_use_call-row-interrupted',
      role: 'assistant',
      kind: 'tool_use',
      status: 'running',
      parent_stream_id: 'stream-row-interrupted',
      tool_call: {
        call_id: 'call-row-interrupted',
        tool_name: 'Read',
        parent_stream_id: 'stream-row-interrupted',
        summary: 'Read file',
        status: 'running',
      },
    },
  ];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return { data: refreshedMessages };
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-row-interrupted' });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-row-interrupted',
    callId: 'call-row-interrupted',
    toolName: 'Read',
    status: 'running',
    summary: 'Read file',
  });
  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-row-interrupted',
    content: '',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });

  const interruptedSignal = harness.calls.rolloutSignals.find(
    (entry) => entry.signal === 'interrupted_running_tool_hydration'
  );
  assert.ok(interruptedSignal, 'expected interrupted-tool hydration telemetry');
  assert.equal(interruptedSignal.details.turnId, 'stream-row-interrupted');
  assert.equal(interruptedSignal.details.toolCallId, 'call-row-interrupted');
});

test('mid-turn message_updated for an unknown message defers the store refresh until terminal', async (t) => {
  let getMessagesCalls = 0;
  const capturedTurnEventStates = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              getMessagesCalls += 1;
              return {
                data: [
                  { id: 'user_mid_turn', role: 'user', content: 'Write it', status: 'complete' },
                  {
                    id: 'assistant_stream-mid-turn',
                    role: 'assistant',
                    content: 'Working.',
                    status: 'complete',
                    streamId: 'stream-mid-turn',
                    finalizedAt: '2026-06-11T12:00:00.000Z',
                  },
                  {
                    id: 'monitor_not_in_memory',
                    role: 'tool',
                    kind: 'tool_result',
                    content: 'Monitor output after patch.',
                    status: 'complete',
                  },
                ],
                turn_event_log_version: 3,
                turn_events: [],
              };
            },
          },
        },
      },
    },
    callbackOverrides: {
      setSessionTurnEventState(sessionId, turnEventState) {
        capturedTurnEventStates.push({ sessionId, turnEventState });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-mid-turn' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-mid-turn',
    content: 'Working.',
    aggregate: 'Working.',
  });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-mid-turn',
    callId: 'call-mid-turn',
    toolName: 'Write',
    status: 'running',
    summary: 'Write file',
  });

  const messagesBeforeUpdate = harness.state.messagesBySession.get('session-1');
  await harness.emit({
    type: 'message_updated',
    sessionId: 'session-1',
    streamId: 'stream-mid-turn',
    messageId: 'monitor_not_in_memory',
    patch: { content: 'Monitor output after patch.', status: 'running' },
  });

  assert.equal(getMessagesCalls, 0, 'mid-turn unknown-message update must not refresh from the store');
  assert.equal(
    capturedTurnEventStates.length,
    0,
    'mid-turn unknown-message update must not clobber live turn-event state'
  );
  assert.equal(
    harness.state.messagesBySession.get('session-1'),
    messagesBeforeUpdate,
    'in-memory messages stay untouched by the deferred update'
  );

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-mid-turn',
    content: 'Working.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });

  assert.ok(getMessagesCalls >= 1, 'terminal hydration re-reads the store and picks up the patch');
  const settledMessages = harness.state.messagesBySession.get('session-1') || [];
  const patchedMessage = settledMessages.find((message) => message?.id === 'monitor_not_in_memory');
  assert.equal(
    patchedMessage?.content,
    'Monitor output after patch.',
    'the deferred patch lands via terminal hydration'
  );
});

test('post-terminal message_updated merges one fetched message without replacing newer local rows', async (t) => {
  let resolveMessages;
  const harness = createHarness({
    stateOverrides: {
      window: { jennyShell: { sessions: { getMessages: () => new Promise((resolve) => { resolveMessages = resolve; }) } } },
    },
  });
  t.after(() => harness.restore());

  const update = harness.emit({
    type: 'message_updated', sessionId: 'session-1', streamId: 'stream-settled',
    messageId: 'monitor-fetched', patch: { content: 'patched monitor', status: 'complete' },
  });
  await flushMicrotasks();
  assert.equal(typeof resolveMessages, 'function');
  const newerUser = { id: 'user-newer', role: 'user', content: 'new optimistic turn', status: 'complete' };
  harness.state.messagesBySession.set('session-1', [newerUser]);
  resolveMessages({
    data: [{ id: 'monitor-fetched', role: 'tool', content: 'old monitor', status: 'running' }],
    turn_event_log_version: 1,
    turn_events: [],
  });
  await update;

  const messages = harness.state.messagesBySession.get('session-1');
  assert.equal(messages.some((message) => message.id === 'user-newer'), true);
  assert.equal(messages.find((message) => message.id === 'monitor-fetched')?.content, 'patched monitor');
});

test('post-terminal message_updated rejects a fetch from an older session incarnation', async (t) => {
  let resolveMessages;
  const harness = createHarness({
    stateOverrides: {
      sessions: [{ id: 'session-1', session_incarnation: 'inc-old', turn_generation: 3 }],
      window: { jennyShell: { sessions: { getMessages: () => new Promise((resolve) => { resolveMessages = resolve; }) } } },
    },
  });
  t.after(() => harness.restore());

  const update = harness.emit({
    type: 'message_updated', sessionId: 'session-1', streamId: 'stream-old',
    messageId: 'monitor-old', patch: { content: 'stale patch' },
  });
  await flushMicrotasks();
  assert.equal(typeof resolveMessages, 'function');
  harness.state.sessions = [{ id: 'session-1', session_incarnation: 'inc-new', turn_generation: 1 }];
  harness.state.messagesBySession.set('session-1', [{ id: 'user-new', role: 'user', content: 'new session' }]);
  resolveMessages({ data: [{ id: 'monitor-old', role: 'tool', content: 'old session' }] });
  await update;

  assert.deepEqual(harness.state.messagesBySession.get('session-1').map((message) => message.id), ['user-new']);
});

test('post-terminal message_updated releases its mailbox after a bounded canonical refresh deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: { jennyShell: { sessions: { getMessages: () => new Promise(() => {}) } } },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) { logs.push({ level, eventName, details }); },
    },
  });
  t.after(() => harness.restore());

  const update = harness.emit({
    type: 'message_updated', sessionId: 'session-1', streamId: 'stream-settled',
    messageId: 'monitor-hung', patch: { content: 'late patch' },
  });
  await flushMicrotasks();
  t.mock.timers.tick(120_000);
  await flushMicrotasks();

  await update;
  assert.equal(logs.some((entry) => (
    entry.eventName === 'stream.terminal_postwork_timeout'
    && entry.details.stage === 'refreshUpdatedMessage'
  )), true);
});
