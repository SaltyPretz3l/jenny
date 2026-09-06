const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CanonicalTurnEventCollector,
} = require('../../services/backend/canonical-turn-event-collector');
const {
  buildCanonicalTurnEvent,
} = require('../../services/backend/canonical-turn-event');
const {
  CanonicalTurnMetrics,
} = require('../../services/backend/canonical-turn-metrics');
const {
  createManagedChatStreamRuntime,
} = require('../../services/backend/chat-stream-managed-runtime');
const {
  handleToolNotification,
} = require('../../services/backend/chat-stream-tool-handling');

test('managed chat stream runtime records canonical orphan-repair metrics', async () => {
  const emitted = [];
  const logs = [];
  const sessionMessages = [];
  const service = {
    currentModel: 'test-model',
    pendingToolApprovals: new Map(),
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        return null;
      },
      updateMessage(_sessionId, messageId, patch) {
        const target = sessionMessages.find(
          (message) => String(message.id || '') === String(messageId || '')
        );
        if (target) Object.assign(target, patch);
        return target || null;
      },
      getSessionMessages() { return sessionMessages; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-orphan-metric',
    sessionId: 'session-orphan-metric',
  });
  const turnMetrics = new CanonicalTurnMetrics();
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-orphan-metric',
    streamId: 'stream-orphan-metric',
    traceId: 'trace-orphan-metric',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-orphan-metric',
    turnEventCollector,
    turnMetrics,
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-orphan-metric',
    streamId: 'stream-orphan-metric',
    eventBase: {
      streamId: 'stream-orphan-metric',
      sessionId: 'session-orphan-metric',
      model: 'test-model',
    },
    adapter: runtime.adapter,
    turnEventCollector,
  };

  runtime.handleNotification({
    method: 'tool.executing',
    params: {
      tool_call_id: 'call-orphan-metric',
      tool_name: 'inspect_harness',
      tool_input: { sections: ['tools'] },
    },
  }, {
    toolContext,
    handleToolNotification,
  });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Recovered visible response.' },
  }, {
    toolContext,
    handleToolNotification,
  });

  await runtime.settleTerminalResult({ status: 'completed' });

  const snapshot = turnMetrics.snapshot();
  assert.equal(snapshot.counters.orphan_tool_repair_count, 1);
  assert.ok(logs.some((entry) => entry.event === 'chat.stream_unfinished_tools_settled'));
  assert.ok(sessionMessages.some((message) => String(message.kind || '') === 'tool_result'));
  assert.ok(emitted.some((event) => event.type === 'tool_result' && event.isError === true));
});

test('managed chat stream runtime canonical bridge projects text once and suppresses legacy duplicate', () => {
  const emitted = [];
  const sessionMessages = [];
  const service = {
    currentModel: 'test-model',
    pendingToolApprovals: new Map(),
    featureFlags: {
      canonical_turn_events: true,
      canonical_bridge: true,
    },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        return null;
      },
      updateMessage(_sessionId, messageId, patch) {
        const target = sessionMessages.find(
          (message) => String(message.id || '') === String(messageId || '')
        );
        if (target) Object.assign(target, patch);
        return target || null;
      },
      getSessionMessages() { return sessionMessages; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-bridge',
    sessionId: 'session-canonical-bridge',
    canonicalPrimary: true,
  });
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-canonical-bridge',
    streamId: 'stream-canonical-bridge',
    traceId: 'trace-canonical-bridge',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-canonical-bridge',
    turnEventCollector,
    canonicalBridge: true,
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-canonical-bridge',
    streamId: 'stream-canonical-bridge',
    eventBase: {
      streamId: 'stream-canonical-bridge',
      sessionId: 'session-canonical-bridge',
      model: 'test-model',
    },
    adapter: runtime.adapter,
    turnEventCollector,
  };

  runtime.handleNotification({
    method: 'turn.event',
    params: buildCanonicalTurnEvent({
      type: 'text_delta',
      turn_id: 'stream-canonical-bridge',
      stream_id: 'stream-canonical-bridge',
      session_id: 'session-canonical-bridge',
      seq: 1,
      payload: { delta: 'Hello ', role: 'assistant', sequence: 1 },
    }),
  }, {
    toolContext,
    handleToolNotification,
  });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Hello ', role: 'assistant', sequence: 1 },
  }, {
    toolContext,
    handleToolNotification,
  });
  runtime.handleNotification({
    method: 'turn.event',
    params: buildCanonicalTurnEvent({
      type: 'text_part_completed',
      turn_id: 'stream-canonical-bridge',
      stream_id: 'stream-canonical-bridge',
      session_id: 'session-canonical-bridge',
      seq: 2,
      payload: {
        text: 'Hello ',
        assistant_phase: 'final_answer',
        segment_id: 'assistant_stream-canonical-bridge_seg_0',
        segment_group_index: 0,
      },
    }),
  }, {
    toolContext,
    handleToolNotification,
  });

  const deltas = emitted.filter((payload) => payload.type === 'delta' && payload.content);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].content, 'Hello ');
  assert.equal(deltas[0].aggregate, 'Hello ');
  assert.equal(turnEventCollector.capturedEvents.some((event) => event.kind === 'assistant_text_segment'), true);
});

test('managed chat stream runtime canonical bridge dedupes unsequenced legacy text before canonical delta', () => {
  const emitted = [];
  const sessionMessages = [];
  const service = {
    currentModel: 'test-model',
    pendingToolApprovals: new Map(),
    featureFlags: {
      canonical_turn_events: true,
      canonical_bridge: true,
    },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        return null;
      },
      updateMessage(_sessionId, messageId, patch) {
        const target = sessionMessages.find(
          (message) => String(message.id || '') === String(messageId || '')
        );
        if (target) Object.assign(target, patch);
        return target || null;
      },
      getSessionMessages() { return sessionMessages; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-unsequenced',
    sessionId: 'session-canonical-unsequenced',
    canonicalPrimary: true,
  });
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-canonical-unsequenced',
    streamId: 'stream-canonical-unsequenced',
    traceId: 'trace-canonical-unsequenced',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-canonical-unsequenced',
    turnEventCollector,
    canonicalBridge: true,
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-canonical-unsequenced',
    streamId: 'stream-canonical-unsequenced',
    eventBase: {
      streamId: 'stream-canonical-unsequenced',
      sessionId: 'session-canonical-unsequenced',
      model: 'test-model',
    },
    adapter: runtime.adapter,
    turnEventCollector,
  };

  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Hello ', role: 'assistant' },
  }, {
    toolContext,
    handleToolNotification,
  });
  runtime.handleNotification({
    method: 'turn.event',
    params: buildCanonicalTurnEvent({
      type: 'text_delta',
      turn_id: 'stream-canonical-unsequenced',
      stream_id: 'stream-canonical-unsequenced',
      session_id: 'session-canonical-unsequenced',
      seq: 1,
      payload: { delta: 'Hello ', role: 'assistant', sequence: 1 },
    }),
  }, {
    toolContext,
    handleToolNotification,
  });

  const deltas = emitted.filter((payload) => payload.type === 'delta' && payload.content);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].content, 'Hello ');
  assert.equal(deltas[0].aggregate, 'Hello ');
});

test('managed chat stream runtime canonical bridge appends completion suffix after partial text deltas', () => {
  const emitted = [];
  const sessionMessages = [];
  const service = {
    currentModel: 'test-model',
    pendingToolApprovals: new Map(),
    featureFlags: {
      canonical_turn_events: true,
      canonical_bridge: true,
    },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        return null;
      },
      updateMessage(_sessionId, messageId, patch) {
        const target = sessionMessages.find(
          (message) => String(message.id || '') === String(messageId || '')
        );
        if (target) Object.assign(target, patch);
        return target || null;
      },
      getSessionMessages() { return sessionMessages; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-completion-suffix',
    sessionId: 'session-canonical-completion-suffix',
    canonicalPrimary: true,
  });
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-canonical-completion-suffix',
    streamId: 'stream-canonical-completion-suffix',
    traceId: 'trace-canonical-completion-suffix',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-canonical-completion-suffix',
    turnEventCollector,
    canonicalBridge: true,
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-canonical-completion-suffix',
    streamId: 'stream-canonical-completion-suffix',
    eventBase: {
      streamId: 'stream-canonical-completion-suffix',
      sessionId: 'session-canonical-completion-suffix',
      model: 'test-model',
    },
    adapter: runtime.adapter,
    turnEventCollector,
  };
  const handleCanonical = (params) => runtime.handleNotification({
    method: 'turn.event',
    params,
  }, {
    toolContext,
    handleToolNotification,
  });

  handleCanonical(buildCanonicalTurnEvent({
    type: 'text_delta',
    turn_id: 'stream-canonical-completion-suffix',
    stream_id: 'stream-canonical-completion-suffix',
    session_id: 'session-canonical-completion-suffix',
    seq: 1,
    payload: { delta: 'Hello ', role: 'assistant', sequence: 1 },
  }));
  handleCanonical(buildCanonicalTurnEvent({
    type: 'text_part_completed',
    turn_id: 'stream-canonical-completion-suffix',
    stream_id: 'stream-canonical-completion-suffix',
    session_id: 'session-canonical-completion-suffix',
    seq: 2,
    payload: {
      text: 'Hello world.',
      assistant_phase: 'final_answer',
      segment_id: 'assistant_stream-canonical-completion-suffix_seg_0',
      segment_group_index: 0,
    },
  }));

  const deltas = emitted.filter((payload) => payload.type === 'delta' && payload.content);
  assert.deepEqual(deltas.map((payload) => payload.content), ['Hello ', 'world.']);
  assert.equal(deltas[1].aggregate, 'Hello world.');
});

test('managed chat stream runtime canonical bridge clears text dedupe state on stream reset', () => {
  const emitted = [];
  const sessionMessages = [];
  const service = {
    currentModel: 'test-model',
    pendingToolApprovals: new Map(),
    featureFlags: {
      canonical_turn_events: true,
      canonical_bridge: true,
    },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        return null;
      },
      updateMessage(_sessionId, messageId, patch) {
        const target = sessionMessages.find(
          (message) => String(message.id || '') === String(messageId || '')
        );
        if (target) Object.assign(target, patch);
        return target || null;
      },
      getSessionMessages() { return sessionMessages; },
      replaceMessages(_sessionId, messages) {
        sessionMessages.splice(0, sessionMessages.length, ...messages);
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-reset',
    sessionId: 'session-canonical-reset',
    canonicalPrimary: true,
  });
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-canonical-reset',
    streamId: 'stream-canonical-reset',
    traceId: 'trace-canonical-reset',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-canonical-reset',
    turnEventCollector,
    canonicalBridge: true,
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-canonical-reset',
    streamId: 'stream-canonical-reset',
    eventBase: {
      streamId: 'stream-canonical-reset',
      sessionId: 'session-canonical-reset',
      model: 'test-model',
    },
    adapter: runtime.adapter,
    turnEventCollector,
  };
  const handle = (method, params) => runtime.handleNotification({ method, params }, {
    toolContext,
    handleToolNotification,
  });

  handle('turn.event', buildCanonicalTurnEvent({
    type: 'text_delta',
    turn_id: 'stream-canonical-reset',
    stream_id: 'stream-canonical-reset',
    session_id: 'session-canonical-reset',
    seq: 1,
    payload: { delta: 'Before reset.', role: 'assistant', sequence: 1 },
  }));
  handle('chat.stream_reset', {});
  handle('turn.event', buildCanonicalTurnEvent({
    type: 'text_delta',
    turn_id: 'stream-canonical-reset',
    stream_id: 'stream-canonical-reset',
    session_id: 'session-canonical-reset',
    seq: 1,
    payload: { delta: 'After reset.', role: 'assistant', sequence: 1 },
  }));

  const deltas = emitted.filter((payload) => payload.type === 'delta' && payload.content);
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].content, 'Before reset.');
  assert.equal(deltas[1].content, 'After reset.');
  assert.equal(deltas[1].aggregate, 'After reset.');
});

test('managed chat stream runtime canonical bridge dedupes mixed legacy and canonical tool starts', () => {
  const emitted = [];
  const sessionMessages = [];
  const service = {
    currentModel: 'test-model',
    pendingToolApprovals: new Map(),
    featureFlags: {
      canonical_turn_events: true,
      canonical_bridge: true,
    },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        return null;
      },
      updateMessage(_sessionId, messageId, patch) {
        const target = sessionMessages.find(
          (message) => String(message.id || '') === String(messageId || '')
        );
        if (target) Object.assign(target, patch);
        return target || null;
      },
      getSessionMessages() { return sessionMessages; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-mixed-tool',
    sessionId: 'session-canonical-mixed-tool',
    canonicalPrimary: true,
  });
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-canonical-mixed-tool',
    streamId: 'stream-canonical-mixed-tool',
    traceId: 'trace-canonical-mixed-tool',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-canonical-mixed-tool',
    turnEventCollector,
    canonicalBridge: true,
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-canonical-mixed-tool',
    streamId: 'stream-canonical-mixed-tool',
    eventBase: {
      streamId: 'stream-canonical-mixed-tool',
      sessionId: 'session-canonical-mixed-tool',
      model: 'test-model',
    },
    adapter: runtime.adapter,
    turnEventCollector,
  };
  const handle = (method, params) => runtime.handleNotification({ method, params }, {
    toolContext,
    handleToolNotification,
  });

  handle('tool.executing', {
    tool_call_id: 'call-mixed-tool',
    tool_name: 'inspect_harness',
    tool_input: { sections: ['tools'] },
  });
  handle('turn.event', buildCanonicalTurnEvent({
    type: 'tool_execution_started',
    turn_id: 'stream-canonical-mixed-tool',
    stream_id: 'stream-canonical-mixed-tool',
    session_id: 'session-canonical-mixed-tool',
    seq: 1,
    tool_call_id: 'call-mixed-tool',
    payload: {
      tool_name: 'inspect_harness',
      tool_input: { sections: ['tools'] },
    },
  }));
  handle('turn.event', buildCanonicalTurnEvent({
    type: 'tool_execution_started',
    turn_id: 'stream-canonical-mixed-tool',
    stream_id: 'stream-canonical-mixed-tool',
    session_id: 'session-canonical-mixed-tool',
    seq: 2,
    tool_call_id: 'call-canonical-first',
    payload: {
      tool_name: 'inspect_harness',
      tool_input: { sections: ['status'] },
    },
  }));
  handle('tool.executing', {
    tool_call_id: 'call-canonical-first',
    tool_name: 'inspect_harness',
    tool_input: { sections: ['status'] },
  });

  const toolUseEvents = emitted.filter((payload) => payload.type === 'tool_use');
  assert.equal(toolUseEvents.length, 2);
  assert.equal(toolUseEvents[0].callId, 'call-mixed-tool');
  assert.equal(toolUseEvents[1].callId, 'call-canonical-first');
  assert.equal(sessionMessages.filter((message) => message.kind === 'tool_use').length, 2);
});

test('managed chat stream runtime canonical bridge projects tool lifecycle without orphan repair', async () => {
  const emitted = [];
  const sessionMessages = [];
  const service = {
    currentModel: 'test-model',
    pendingToolApprovals: new Map(),
    featureFlags: {
      canonical_turn_events: true,
      canonical_bridge: true,
    },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        return null;
      },
      updateMessage(_sessionId, messageId, patch) {
        const target = sessionMessages.find(
          (message) => String(message.id || '') === String(messageId || '')
        );
        if (target) Object.assign(target, patch);
        return target || null;
      },
      getSessionMessages() { return sessionMessages; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-tool',
    sessionId: 'session-canonical-tool',
    canonicalPrimary: true,
  });
  const turnMetrics = new CanonicalTurnMetrics();
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-canonical-tool',
    streamId: 'stream-canonical-tool',
    traceId: 'trace-canonical-tool',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-canonical-tool',
    turnEventCollector,
    turnMetrics,
    canonicalBridge: true,
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-canonical-tool',
    streamId: 'stream-canonical-tool',
    eventBase: {
      streamId: 'stream-canonical-tool',
      sessionId: 'session-canonical-tool',
      model: 'test-model',
    },
    adapter: runtime.adapter,
    turnEventCollector,
  };
  const handle = (params) => runtime.handleNotification({
    method: 'turn.event',
    params,
  }, {
    toolContext,
    handleToolNotification,
  });

  handle(buildCanonicalTurnEvent({
    type: 'tool_execution_started',
    turn_id: 'stream-canonical-tool',
    stream_id: 'stream-canonical-tool',
    session_id: 'session-canonical-tool',
    seq: 1,
    tool_call_id: 'call-canonical-tool',
    payload: {
      tool_name: 'inspect_harness',
      tool_input: { sections: ['tools'] },
    },
  }));
  handle(buildCanonicalTurnEvent({
    type: 'tool_execution_completed',
    turn_id: 'stream-canonical-tool',
    stream_id: 'stream-canonical-tool',
    session_id: 'session-canonical-tool',
    seq: 2,
    tool_call_id: 'call-canonical-tool',
    payload: {
      tool_name: 'inspect_harness',
      success: true,
      tool_output_summary: 'ok',
      content_type: 'text',
      tool_input: { sections: ['tools'] },
      metadata: { result_kind: 'diagnostic' },
    },
  }));
  handle(buildCanonicalTurnEvent({
    type: 'text_delta',
    turn_id: 'stream-canonical-tool',
    stream_id: 'stream-canonical-tool',
    session_id: 'session-canonical-tool',
    seq: 3,
    payload: { delta: 'Done.', role: 'assistant', sequence: 1 },
  }));

  await runtime.settleTerminalResult({ status: 'completed' });

  assert.ok(sessionMessages.some((message) => String(message.kind || '') === 'tool_result'));
  assert.ok(emitted.some((payload) => payload.type === 'tool_use' && payload.callId === 'call-canonical-tool'));
  assert.ok(emitted.some((payload) => payload.type === 'tool_result' && payload.callId === 'call-canonical-tool'));
  assert.equal(turnMetrics.snapshot().counters.orphan_tool_repair_count, 0);
});
