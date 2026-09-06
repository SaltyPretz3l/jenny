const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  createManagedService,
} = require('../helpers/managed-sidecar-runtime-helpers');
const {
  createManagedChatStreamRuntime,
} = require('../../services/backend/chat-stream-managed-runtime');
const {
  buildCanonicalTurnEvent,
} = require('../../services/backend/canonical-turn-event');
const {
  CanonicalTurnEventCollector,
} = require('../../services/backend/canonical-turn-event-collector');
const {
  CanonicalTurnMetrics,
} = require('../../services/backend/canonical-turn-metrics');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar runtime keeps transient thinking out of persisted assistant reasoning', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-thinking-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();
  const created = await service.createSession({
    title: 'Managed Thinking Session',
    preferences: {
      preferred_model: 'mock-v1',
    },
  });

  const thinkingStatus = waitForChatStreamEvent(
    service,
    (event) => event.type === 'thinking_status' && /Thinking through the request/i.test(String(event.text || ''))
  );
  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );
  const approvalEvents = [];
  service.on('chat-stream', (event) => {
    if (event.type === 'tool_approval_needed') {
      approvalEvents.push(event);
    }
  });

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Please write a note after approval',
    preferredModel: 'mock-v1',
    planMode: true,
  });

  const thinking = await thinkingStatus;
  assert.equal(thinking.streamId, stream.streamId);
  assert.match(String(thinking.text || ''), /Thinking through the request/i);

  await completed;
  assert.equal(approvalEvents.length, 0);

  const messages = await service.getSessionMessages(stream.sessionId);
  const assistantMessage = messages.data.find((message) => message.id === `assistant_${stream.streamId}`);
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.reasoning?.source, 'none');
  assert.deepEqual(assistantMessage.reasoning?.entries || [], []);
  const toolResultMessage = messages.data.find((message) => message.kind === 'tool_result');
  assert.ok(toolResultMessage);
  assert.equal(toolResultMessage.tool_result.error_code, 'CMP-MODE-0002');
  assert.equal(toolResultMessage.tool_result.metadata.read_only_blocked, true);

  await service.stop();
});

test('managed sidecar runtime streams and persists provider reasoning for qwen3.5 text turns', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-provider-thinking-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();
  await service.loadModel('qwen3.5:9b');

  const created = await service.createSession({
    title: 'Managed Provider Thinking Session',
    preferences: {
      preferred_model: 'qwen3.5:9b',
      reasoning_effort: 'high',
    },
  });

  const reasoningEvents = [];
  const completion = new Promise((resolve) => {
    service.on('chat-stream', function handler(event) {
      if (event.reasoning) {
        reasoningEvents.push(event.reasoning);
      }
      if (event.type === 'complete') {
        service.off('chat-stream', handler);
        resolve(event);
      }
    });
  });

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Show provider reasoning live',
    preferredModel: 'qwen3.5:9b',
    reasoningEffort: 'high',
  });

  await completion;

  assert.ok(reasoningEvents.length >= 2);
  assert.equal(reasoningEvents[0].source, 'provider');
  assert.match(String(reasoningEvents[0].entriesDelta[0].text || ''), /Checking the request intent/i);
  assert.match(String(reasoningEvents.at(-1).entriesDelta[0].text || ''), /Forming a concise answer/i);

  const messages = await service.getSessionMessages(stream.sessionId);
  const assistantMessage = messages.data.find((message) => message.id === `assistant_${stream.streamId}`);
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.reasoning?.source, 'provider');
  assert.equal((assistantMessage.reasoning?.entries || []).length, 1);
  assert.match(String(assistantMessage.reasoning.entries[0].text || ''), /Checking the request intent/i);
  assert.match(String(assistantMessage.reasoning.entries[0].text || ''), /Forming a concise answer/i);
  assert.equal(assistantMessage.parent_stream_id, stream.streamId);
  assert.equal(
    (assistantMessage.visible_segments || []).map((segment) => segment.text).join(''),
    assistantMessage.content
  );
  assert.deepEqual(
    (assistantMessage.phases || []).map((phase) => phase.phase_kind),
    ['reasoning', 'text']
  );
  assert.equal(
    (assistantMessage.phases || []).find((phase) => phase.phase_kind === 'reasoning')?.render_collapsed,
    false
  );

  await service.stop();
});

test('managed sidecar runtime emits reasoning and text phase notifications when phase events are enabled', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-phase-events-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath, {
    featureFlags: { phase_events: true },
  });
  await service.start();
  await service.loadModel('qwen3.5:9b');

  const created = await service.createSession({
    title: 'Managed Phase Session',
    preferences: {
      preferred_model: 'qwen3.5:9b',
      reasoning_effort: 'high',
    },
  });

  const phaseEvents = [];
  const completion = new Promise((resolve) => {
    service.on('chat-stream', function handler(event) {
      if (event.type === 'phase_started' || event.type === 'phase_completed') {
        phaseEvents.push(event);
      }
      if (event.type === 'complete') {
        service.off('chat-stream', handler);
        resolve(event);
      }
    });
  });

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Show provider reasoning live',
    preferredModel: 'qwen3.5:9b',
    reasoningEffort: 'high',
  });

  await completion;

  assert.equal(stream.streamId.length > 0, true);
  assert.deepEqual(
    phaseEvents.map((event) => [event.type, event.phaseKind]),
    [
      ['phase_started', 'reasoning'],
      ['phase_completed', 'reasoning'],
      ['phase_started', 'text'],
      ['phase_completed', 'text'],
    ]
  );
  assert.equal(String(phaseEvents[0].thinkingId || '').startsWith('think_'), true);
  assert.equal(phaseEvents[0].iteration, 1);

  await service.stop();
});

test('managed sidecar runtime emits approval_wait phase notifications around blocking approvals', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-approval-phase-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath, {
    featureFlags: { phase_events: true },
  });
  await service.start();
  const created = await service.createSession({
    title: 'Managed Approval Session',
    preferences: {
      preferred_model: 'mock-v1',
    },
  });

  const phaseEvents = [];
  service.on('chat-stream', (event) => {
    if (event.type === 'phase_started' || event.type === 'phase_completed') {
      phaseEvents.push(event);
    }
  });

  const approvalNeeded = waitForChatStreamEvent(
    service,
    (event) => event.type === 'tool_approval_needed'
  );
  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Please write a note after approval',
    preferredModel: 'mock-v1',
  });

  const approvalEvent = await approvalNeeded;
  await service.approveToolCall(approvalEvent.callId);
  await completed;

  const approvalPhases = phaseEvents.filter((event) => event.phaseKind === 'approval_wait');
  assert.deepEqual(
    approvalPhases.map((event) => event.type),
    ['phase_started', 'phase_completed']
  );
  assert.equal(approvalPhases[0].toolCallId, approvalEvent.callId);
  assert.equal(approvalPhases[0].toolName, 'write_file');

  await service.stop();
});

test('managed chat stream runtime stamps V2 stream metadata on raw events before bridge coalescing', () => {
  const emitted = [];
  const service = {
    featureFlags: { stream_envelope_v2: true, phase_events: true },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage() { return null; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-v2',
    streamId: 'stream-v2-runtime',
    traceId: 'trace-v2-runtime',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-v2-runtime',
  });

  const context = {
    toolContext: {},
    handleToolNotification() {},
  };
  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: 'phase_reasoning_1',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_1',
      summary: 'Provider summary',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'Checking intent',
      thinking_id: 'think_1',
      kind: 'reasoning',
      persist: true,
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.phase_completed',
    params: {
      phase_id: 'phase_reasoning_1',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_1',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: 'phase_text_1',
      phase_kind: 'text',
      iteration: 1,
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.token',
    params: {
      delta: 'Hello',
      sequence: 11,
    },
  }, context);

  const reasoningDelta = emitted.find((event) => event.type === 'delta' && event.reasoning);
  const responseDelta = emitted.find((event) => event.type === 'delta' && event.content === 'Hello');
  const phaseStarted = emitted.find((event) => event.type === 'phase_started' && event.phaseKind === 'reasoning');
  assert.ok(phaseStarted);
  assert.ok(reasoningDelta);
  assert.ok(responseDelta);

  assert.equal(phaseStarted.channel, 'phase');
  assert.equal(phaseStarted.channelSequence, 1);
  assert.equal(phaseStarted.sequenceEnd, phaseStarted.sequence);
  assert.equal(phaseStarted.channelSequenceEnd, phaseStarted.channelSequence);
  assert.equal(phaseStarted.phase.phaseId, 'phase_reasoning_1');
  assert.equal(phaseStarted.phase.phaseKind, 'reasoning');
  assert.equal(Number.isInteger(phaseStarted.sequence), true);
  assert.equal(Number.isFinite(phaseStarted.emittedAtMs), true);

  assert.equal(reasoningDelta.channel, 'reasoning');
  assert.equal(reasoningDelta.channelSequence, 1);
  assert.equal(reasoningDelta.sequenceEnd, reasoningDelta.sequence);
  assert.equal(reasoningDelta.channelSequenceEnd, reasoningDelta.channelSequence);
  assert.equal(reasoningDelta.phase.phaseId, 'phase_reasoning_1');
  assert.equal(reasoningDelta.reasoning.summary, 'Provider summary');
  assert.equal(Number.isFinite(reasoningDelta.emittedAtMs), true);

  assert.equal(responseDelta.channel, 'response');
  assert.equal(responseDelta.sequence, 5);
  assert.equal(responseDelta.sequenceEnd, responseDelta.sequence);
  assert.equal(responseDelta.tokenSequence, 11);
  assert.equal(responseDelta.channelSequence, 1);
  assert.equal(responseDelta.channelSequenceEnd, responseDelta.channelSequence);
  assert.equal(responseDelta.phase.phaseId, 'phase_text_1');
  assert.equal(responseDelta.phase.phaseKind, 'text');
});

test('managed chat stream runtime captures canonical turn.event without renderer duplication', () => {
  const emitted = [];
  const service = {
    featureFlags: { stream_envelope_v2: true },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage() { return null; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-runtime',
    sessionId: 'session-canonical-runtime',
  });
  const turnMetrics = new CanonicalTurnMetrics();
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-canonical-runtime',
    streamId: 'stream-canonical-runtime',
    traceId: 'trace-canonical-runtime',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-canonical-runtime',
    turnEventCollector,
    turnMetrics,
  });

  runtime.handleNotification({
    method: 'turn.event',
    params: buildCanonicalTurnEvent({
      type: 'tool_call_requested',
      turn_id: 'stream-canonical-runtime',
      session_id: 'session-canonical-runtime',
      seq: 1,
      tool_call_id: 'call-canonical-runtime',
      payload: {
        tool_name: 'read_file',
        tool_input: { path: 'README.md' },
      },
    }),
  }, {
    toolContext: {},
    handleToolNotification() {},
  });

  assert.equal(emitted.length, 0);
  assert.equal(turnEventCollector.capturedEvents.length, 1);
  assert.equal(turnEventCollector.capturedEvents[0].kind, 'tool_use');
  assert.equal(turnEventCollector.capturedEvents[0].tool_call_id, 'call-canonical-runtime');
  const snapshot = turnMetrics.snapshot();
  assert.equal(snapshot.counters.canonical_events_emitted, 1);
  assert.equal(snapshot.counters.legacy_notifications_emitted, 0);
});

test('managed chat stream runtime does not stamp response deltas with stale reasoning phase', () => {
  const emitted = [];
  const service = {
    featureFlags: { stream_envelope_v2: true, phase_events: true },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage() { return null; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-v2-stale-phase',
    streamId: 'stream-v2-stale-phase',
    traceId: 'trace-v2-stale-phase',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-v2-stale-phase',
  });
  const context = {
    toolContext: {},
    handleToolNotification() {},
  };

  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: 'phase_reasoning_stale',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_stale',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.phase_completed',
    params: {
      phase_id: 'phase_reasoning_stale',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_stale',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.token',
    params: {
      delta: 'Visible answer',
      sequence: 1,
    },
  }, context);

  const responseDelta = emitted.find((event) => event.type === 'delta' && event.content === 'Visible answer');
  assert.ok(responseDelta);
  assert.equal(responseDelta.sequence, 3);
  assert.equal(responseDelta.tokenSequence, 1);
  assert.equal(responseDelta.phase.phaseKind, 'text');
  assert.equal(responseDelta.phase.phaseId || '', '');
});

test('managed chat stream runtime resets stale thinking ids before the next reasoning delta after stream_reset', () => {
  const emitted = [];
  const service = {
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage() { return null; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-1',
    streamId: 'stream-reset-1',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-reset-1',
  });

  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'Old status',
      thinking_id: 'think_old',
      kind: 'status',
      persist: false,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.stream_reset',
    params: {},
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'Fresh reasoning after reset.',
      thinking_id: 'think_new',
      kind: 'reasoning',
      persist: true,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });

  const latestReasoningDelta = emitted.filter((event) => event.type === 'delta').at(-1);
  assert.ok(latestReasoningDelta);
  assert.equal(latestReasoningDelta.reasoning.entriesDelta[0].thinkingId, 'think_new');
});

test('managed chat stream runtime finalizes visible completion once for overlapping terminal settlement', async () => {
  const emitted = [];
  const persistedMessages = [];
  let resolvePersist;
  const persistWait = new Promise((resolve) => {
    resolvePersist = resolve;
  });
  const service = {
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        return persistWait;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-1',
    streamId: 'stream-single-flight-1',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-single-flight-1',
  });

  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Hello once.' },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });

  const firstSettle = runtime.settleTerminalResult({ status: 'completed' });
  const secondSettle = runtime.settleTerminalResult({ status: 'completed' });
  await Promise.resolve();

  assert.equal(persistedMessages.length, 1);
  resolvePersist();
  await Promise.all([firstSettle, secondSettle]);
  assert.equal(
    emitted.filter((event) => event.type === 'complete').length,
    1
  );
});

test('managed chat stream runtime fails closed when persisted reasoning arrives after text without a new phase boundary', async () => {
  const service = {
    featureFlags: { phase_events: true },
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage() { return null; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-1',
    streamId: 'stream-protocol-1',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-protocol-1',
  });

  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: 'phase_text_1',
      phase_kind: 'text',
      iteration: 1,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.token',
    params: {
      delta: 'Visible answer.',
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'Late hidden reasoning.',
      thinking_id: 'think_late',
      kind: 'reasoning',
      persist: true,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });

  await assert.rejects(
    runtime.settleTerminalResult({ status: 'completed' }),
    (error) => {
      assert.equal(error.error_code, 'CMP-CHAT-0013');
      assert.equal(error.code, 'CMP-CHAT-0013');
      assert.equal(error.terminal_subcode, 'protocol_violation');
      return true;
    }
  );
});

test('managed chat stream runtime treats chat.done stop_reason error as terminal failure after partial text', async () => {
  const emitted = [];
  const persistedMessages = [];
  const service = {
    featureFlags: {},
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-1',
    streamId: 'stream-done-error-1',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-done-error-1',
  });

  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Partial answer before provider failure.' },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.done',
    params: {
      stop_reason: 'error',
      code: 'CMP-PROVIDER-9999',
      message: 'Provider failed after partial output.',
      retryable: false,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });

  await assert.rejects(
    runtime.settleTerminalResult({ status: 'completed' }),
    (error) => {
      assert.equal(error.error_code, 'CMP-PROVIDER-9999');
      assert.equal(error.retryable, false);
      assert.match(String(error.message || ''), /Provider failed after partial output/);
      return true;
    }
  );
  assert.equal(emitted.some((event) => event.type === 'complete'), false);
  assert.equal(persistedMessages.some((message) => message.role === 'assistant' && message.content), false);
});

test('managed chat stream runtime preserves reasoning phase summary and token rate telemetry', async () => {
  const emitted = [];
  const persistedMessages = [];
  const service = {
    featureFlags: { phase_events: true },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-1',
    streamId: 'stream-telemetry-1',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-telemetry-1',
  });

  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: 'phase_reasoning_1',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_telemetry',
      summary: 'Checking file context.',
      tokens_per_second: 18.5,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'Reading the relevant context.',
      thinking_id: 'think_telemetry',
      kind: 'reasoning',
      persist: true,
      tokens_per_second: 18.5,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.phase_completed',
    params: {
      phase_id: 'phase_reasoning_1',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_telemetry',
      summary: 'Context checked.',
      tokens_per_second: 19.25,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Telemetry preserved.' },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });

  await runtime.settleTerminalResult({ status: 'completed' });

  const started = emitted.find((event) => event.type === 'phase_started');
  const completed = emitted.find((event) => event.type === 'phase_completed');
  assert.equal(started.summary, 'Checking file context.');
  assert.equal(started.tokensPerSecond, 18.5);
  assert.equal(completed.summary, 'Context checked.');
  assert.equal(completed.tokensPerSecond, 19.25);
  const reasoningDelta = emitted.find((event) => event.reasoning?.entriesDelta);
  assert.equal(reasoningDelta.reasoning.tokensPerSecond, 18.5);

  const assistant = persistedMessages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.phases[0].summary, 'Context checked.');
  assert.equal(assistant.phases[0].tokens_per_second, 19.25);
  assert.equal(assistant.reasoning_phases[0].summary, 'Context checked.');
  assert.equal(assistant.reasoning_phases[0].tokensPerSecond, 19.25);
});

test('managed chat stream runtime surfaces reasoning-only completion as CMP-STREAM-REASONING-ONLY chat.error', async () => {
  // Phase 4 — when the sidecar emits chat.error with the new
  // CMP-STREAM-REASONING-ONLY code instead of chat.done, the managed
  // runtime must propagate the error rather than fabricate an empty
  // assistant completion. Verifies the wire-surface behavior of the
  // reasoning-only fail-closed path added in `chat_streaming.py`.
  const service = {
    featureFlags: {},
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage() { return null; },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-1',
    streamId: 'stream-reasoning-only-1',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-reasoning-only-1',
  });

  // Simulate the sidecar emitting chat.thinking deltas followed by
  // chat.error with CMP-STREAM-REASONING-ONLY (no chat.done).
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'I should explain this carefully.',
      thinking_id: 'think_reasoning_only',
      kind: 'reasoning',
      persist: false,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });
  runtime.handleNotification({
    method: 'chat.error',
    params: {
      code: 'CMP-STREAM-REASONING-ONLY',
      message: 'Reasoning-only completion (no visible text and no tool call)',
      retryable: false,
    },
  }, {
    toolContext: {},
    handleToolNotification() {},
  });

  // The runtime should surface the failure rather than fabricate a
  // visible assistant message; settleTerminalResult either rejects or
  // returns a non-completed shape carrying the new error code.
  let surfacedCode;
  try {
    const result = await runtime.settleTerminalResult({ status: 'completed' });
    surfacedCode =
      result && result.error_code
        ? String(result.error_code)
        : null;
  } catch (error) {
    surfacedCode = String(error.code || error.error_code || error.message || '');
  }
  assert.match(
    String(surfacedCode || ''),
    /CMP-STREAM-REASONING-ONLY|Reasoning-only completion|no visible/i,
    'expected the runtime to surface the reasoning-only failure'
  );
});
