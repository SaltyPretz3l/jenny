'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  settleManagedAssistantCompletion,
  settleManagedFailureTerminal,
  settleManagedQuestionBatch,
  supportsManagedTerminalCoordinator,
} = require('../services/backend/chat-stream-managed-terminal-settlement');
const {
  createManagedChatStreamRuntime,
} = require('../services/backend/chat-stream-managed-runtime');

function context() {
  const captured = [];
  const order = [];
  const retargetCalls = [];
  const identity = {
    sessionId: 'session_1', sessionIncarnation: 'inc_1', generation: 1,
    turnId: 'turn_1', streamId: 'stream_1', userMessageId: 'user_1',
  };
  const store = { getSessionMessages: () => [], commitTerminal() {} };
  const service = { terminalCoordinator: { async settle(request) {
    order.push('settle');
    captured.push(request);
    return { ok: true, visibleTerminal: true, durableTerminal: true };
  } } };
  const slice = { phases: [], visibleSegments: [], toolSteps: [] };
  // Reasoning-ownership spy: the recording-layer retarget must run before the
  // coordinator serializes the turn events, so both the call shape and the
  // ordering relative to settle are observable here.
  const turnEventCollector = {
    retargetCapturedEvents(turnId, options) {
      order.push('retarget');
      retargetCalls.push({ turnId, ...options });
      return 1;
    },
  };
  return {
    captured,
    order,
    retargetCalls,
    slice,
    ctx: {
      service, turnLease: { identity, store }, streamId: 'stream_1', resolvedSessionId: 'session_1',
      assistantBaseMessageId: 'assistant_stream_1', assistantText: 'Before. After.',
      currentSegmentText: 'After.', textSegmentIndex: 1, hasPersistedSegments: true,
      persistedTextSegmentIds: ['assistant_stream_1_seg0'], segmentPersistRefused: false,
      refusedTextSegments: [],
      reasoningEntries: [], model: 'local', normalizedPreferences: {},
      normalizedInteractiveResponse: null, exchangeTitle: '', eventBase: { streamId: 'stream_1' },
      turnUsage: null, unfinishedToolRepairs: [], turnEventCollector,
      transcriptCollector: { slice, completeCurrentPhase() {}, resetSlice() {} },
      visibleCompletionEmitted: false, terminalPersistRefused: false,
      visibleAssistantMessageId: 'assistant_stream_1_seg0', onVisibleCompletion() {},
      streamSawBatch: false, userMessagePersisted: true,
      terminalCoordinatorHandled: false,
    },
  };
}

test('managed segmented completion commits only the tail and keeps repair content non-duplicating', async () => {
  const { captured, ctx } = context();
  assert.equal(supportsManagedTerminalCoordinator(ctx), true);
  const settled = await settleManagedAssistantCompletion(ctx);
  assert.equal(settled.handled, true);
  assert.equal(captured[0].messages.length, 1);
  assert.equal(captured[0].messages[0].content, 'After.');
  assert.equal(captured[0].terminal.repairMessage.content, 'After.');
  assert.equal(ctx.terminalCoordinatorHandled, true);
});

test('managed completion persists and emits a resumable stop when present', async () => {
  const { captured, ctx } = context();
  ctx.resumableStop = 'context_budget';

  await settleManagedAssistantCompletion(ctx);

  assert.equal(captured[0].messages[0].resumable_stop, 'context_budget');
  assert.equal(captured[0].terminal.rendererPayload.resumableStop, 'context_budget');
});

test('managed completion omits resumable stop fields when absent', async () => {
  const { captured, ctx } = context();

  await settleManagedAssistantCompletion(ctx);

  assert.equal(Object.hasOwn(captured[0].messages[0], 'resumable_stop'), false);
  assert.equal(Object.hasOwn(captured[0].terminal.rendererPayload, 'resumableStop'), false);
});

test('non-coordinator completion emits resumableStop only when chat.done carries it', async () => {
  for (const [suffix, resumableStop] of [
    ['present', 'max_iterations'],
    ['absent', null],
  ]) {
    const emittedEvents = [];
    const persistedMessages = [];
    const service = {
      featureFlags: {},
      emit(eventName, payload) {
        emittedEvents.push({ eventName, payload });
      },
      _emitServiceLog() {},
      renameSession: async () => null,
      sessionStore: {
        appendMessage(_sessionId, message) {
          persistedMessages.push(message);
          return message;
        },
        setSessionPreferences() {},
        getActiveTurn() { return null; },
        setActiveTurn() {},
        touchActiveTurn() {},
        clearActiveTurn() {},
        getSessionMessages() { return []; },
      },
    };
    const runtime = createManagedChatStreamRuntime({
      service,
      resolvedSessionId: `session_${suffix}`,
      streamId: `stream_${suffix}`,
      normalizedPreferences: {},
      normalizedInteractiveResponse: null,
      normalizedAttachments: [],
      transcriptPrompt: 'Prompt',
      userMessageId: `user_${suffix}`,
    });
    const notificationDeps = { toolContext: {}, handleToolNotification() {} };
    runtime.handleNotification({
      method: 'chat.token',
      params: { delta: 'Done.' },
    }, notificationDeps);
    runtime.handleNotification({
      method: 'chat.done',
      params: {
        stop_reason: 'end_turn',
        ...(resumableStop ? { resumable_stop: resumableStop } : {}),
      },
    }, notificationDeps);

    await runtime.settleTerminalResult({ status: 'completed' });

    const complete = emittedEvents.find(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    );
    assert.ok(complete);
    if (resumableStop) {
      assert.equal(complete.payload.resumableStop, resumableStop);
      assert.equal(persistedMessages[0].resumable_stop, resumableStop);
    } else {
      assert.equal(Object.hasOwn(complete.payload, 'resumableStop'), false);
      assert.equal(Object.hasOwn(persistedMessages[0], 'resumable_stop'), false);
    }
  }
});

function resumableStopRuntimeService(persistedMessages, emittedEvents) {
  return {
    featureFlags: {},
    emit(eventName, payload) { emittedEvents.push({ eventName, payload }); },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) { persistedMessages.push(message); return message; },
      setSessionPreferences() {},
      getActiveTurn() { return null; },
      setActiveTurn() {},
      touchActiveTurn() {},
      clearActiveTurn() {},
      getSessionMessages() { return []; },
    },
  };
}

// A tool-cap turn ran tools by definition, so its text was already flushed at a
// tool boundary and the FINAL slice is persisted by persistCurrentTextSegment --
// not by buildAssistantCompletionTerminalMutation. Without the finalize-only
// carry the button paints live and vanishes on reload.
test('non-coordinator segmented completion still persists resumable_stop on the final slice', async () => {
  const emittedEvents = [];
  const persistedMessages = [];
  const runtime = createManagedChatStreamRuntime({
    service: resumableStopRuntimeService(persistedMessages, emittedEvents),
    resolvedSessionId: 'session_seg_stop',
    streamId: 'stream_seg_stop',
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user_seg_stop',
  });
  const notificationDeps = { toolContext: {}, handleToolNotification() {} };

  runtime.handleNotification({ method: 'chat.token', params: { delta: 'Looking.' } }, notificationDeps);
  runtime.handleNotification({ method: 'tool.executing', params: { tool_call_id: 'call_1', tool_name: 'read_file' } }, notificationDeps);
  runtime.handleNotification({ method: 'chat.token', params: { delta: 'Reached this turn tool limit.' } }, notificationDeps);
  runtime.handleNotification({
    method: 'chat.done',
    params: { stop_reason: 'end_turn', resumable_stop: 'tool_cap' },
  }, notificationDeps);

  await runtime.settleTerminalResult({ status: 'completed' });

  const finalMessage = persistedMessages[persistedMessages.length - 1];
  assert.equal(persistedMessages.length > 1, true);
  assert.equal(finalMessage.resumable_stop, 'tool_cap');
  // Only the final slice carries it -- a boundary segment is not the turn's end.
  assert.equal(Object.hasOwn(persistedMessages[0], 'resumable_stop'), false);
});

// The coordinator path reads the detail off the runtime ctx, so this is the only
// test that fails if the ctx getter is dropped: the settlement tests above build
// ctx as a plain object literal and never touch the real closure.
test('coordinator settle reads resumable_stop through the real runtime ctx', async () => {
  const emittedEvents = [];
  const persistedMessages = [];
  const settleRequests = [];
  const service = resumableStopRuntimeService(persistedMessages, emittedEvents);
  service.terminalCoordinator = {
    async settle(request) {
      settleRequests.push(request);
      return { ok: true, visibleTerminal: true, durableTerminal: true, persistedMessageIds: [] };
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session_ctx_stop',
    streamId: 'stream_ctx_stop',
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user_ctx_stop',
    turnLease: {
      identity: {
        sessionId: 'session_ctx_stop', sessionIncarnation: 'inc_1', generation: 1,
        turnId: 'turn_ctx_stop', streamId: 'stream_ctx_stop', userMessageId: 'user_ctx_stop',
      },
      store: { getSessionMessages: () => [], commitTerminal() {} },
    },
  });
  const notificationDeps = { toolContext: {}, handleToolNotification() {} };

  runtime.handleNotification({ method: 'chat.token', params: { delta: 'Done.' } }, notificationDeps);
  runtime.handleNotification({
    method: 'chat.done',
    params: { stop_reason: 'end_turn', resumable_stop: 'diminishing_returns' },
  }, notificationDeps);

  await runtime.settleTerminalResult({ status: 'completed' });

  assert.equal(settleRequests.length, 1);
  assert.equal(settleRequests[0].messages[0].resumable_stop, 'diminishing_returns');
  assert.equal(settleRequests[0].terminal.rendererPayload.resumableStop, 'diminishing_returns');
});


test('managed segment refusal commits the exact missing suffix without duplicating its durable prefix', async () => {
  const { captured, ctx } = context();
  ctx.segmentPersistRefused = true;
  ctx.textSegmentIndex = 2;
  ctx.refusedTextSegments = [{
    id: 'assistant_stream_1_seg1',
    role: 'assistant',
    content: 'Middle. ',
    timestamp: '2026-07-14T12:00:01.000Z',
    client_message_id: 'assistant_stream_1_seg1',
    model_used: 'local',
  }];

  await settleManagedAssistantCompletion(ctx);

  assert.deepEqual(
    captured[0].messages.map((message) => [message.id, message.content]),
    [
      ['assistant_stream_1_seg1', 'Middle. '],
      ['assistant_stream_1_seg2', 'After.'],
    ]
  );
  assert.equal(captured[0].terminal.repairMessage.content, 'Middle. After.');
  assert.equal(captured[0].terminal.preexistingRefusalReason, undefined);
});

test('managed segmented completion retargets the final slice reasoning onto the settled segment id', async () => {
  const { ctx, order, retargetCalls, slice } = context();
  slice.phases = [
    { phase_kind: 'text', phase_id: 'phase_t1' },
    { phase_kind: 'reasoning', phase_id: 'phase_r2' },
  ];

  await settleManagedAssistantCompletion(ctx);

  assert.deepEqual(retargetCalls, [{
    turnId: 'stream_1',
    phaseIds: ['phase_r2'],
    messageId: 'assistant_stream_1_seg1',
  }]);
  // The coordinator serializes captured events inside settle, so a retarget
  // that lands after it never reaches disk.
  assert.deepEqual(order, ['retarget', 'settle']);
});

test('managed text-less settle persists a content-less segment for trailing reasoning', async () => {
  const { captured, ctx, retargetCalls, slice } = context();
  const visibleCompletions = [];
  ctx.assistantText = 'Before the tool.';
  ctx.currentSegmentText = '';
  ctx.onVisibleCompletion = (completion) => visibleCompletions.push(completion);
  slice.phases = [{
    phase_kind: 'reasoning',
    phase_id: 'phase_r2',
    entries: [{ id: 'entry_r2', text: 'Checking the result.' }],
  }];

  await settleManagedAssistantCompletion(ctx);

  assert.equal(captured[0].messages.length, 1);
  assert.equal(captured[0].messages[0].id, 'assistant_stream_1_seg1');
  assert.equal(captured[0].messages[0].content, '');
  assert.deepEqual(captured[0].messages[0].reasoning.entries, [
    { id: 'entry_r2', text: 'Checking the result.', timestamp: '' },
  ]);
  assert.equal(captured[0].terminal.repairMessage, undefined);
  assert.deepEqual(retargetCalls, [{
    turnId: 'stream_1',
    phaseIds: ['phase_r2'],
    messageId: 'assistant_stream_1_seg1',
  }]);
  assert.equal(ctx.visibleAssistantMessageId, 'assistant_stream_1_seg1');
  assert.deepEqual(visibleCompletions, [{
    sessionId: 'session_1',
    messageId: 'assistant_stream_1_seg1',
    content: 'Before the tool.',
    model: 'local',
    usage: null,
  }]);
});

test('a non-segmented completion leaves reasoning on the base assistant id', async () => {
  const { ctx, retargetCalls, slice } = context();
  ctx.hasPersistedSegments = false;
  ctx.persistedTextSegmentIds = [];
  ctx.textSegmentIndex = 0;
  ctx.currentSegmentText = 'Whole reply.';
  ctx.assistantText = 'Whole reply.';
  ctx.visibleAssistantMessageId = '';
  slice.phases = [{ phase_kind: 'reasoning', phase_id: 'phase_r1' }];

  await settleManagedAssistantCompletion(ctx);

  assert.equal(retargetCalls.length, 0);
});

test('managed question and denied failure are coordinator-owned terminals', async () => {
  const { captured, ctx } = context();
  const batch = { batch_id: 'batch_1', round_index: 1, questions: [{ id: 'q1' }] };
  await settleManagedQuestionBatch(ctx, batch);
  assert.equal(captured[0].terminal.kind, 'question_batch');
  ctx.turnLease.terminalCoordinatorRequest = null;
  await settleManagedFailureTerminal(ctx, { message: 'denied' }, {
    status: 'denied', terminalSubcode: '', persistAssistantFailure: false,
  });
  assert.equal(captured[1].terminal.kind, 'denied');
  assert.equal(captured[1].terminal.rendererPayload.type, 'error');
  assert.deepEqual(captured[1].messages, []);
});

test('managed failure terminals preserve provider usage for history recording', async () => {
  const { captured, ctx } = context();
  ctx.turnUsage = {
    input_tokens: 12,
    output_tokens: 4,
    total_tokens: 16,
    generation_tokens: 4,
    generation_duration_ms: 250,
    time_to_first_token_ms: 80,
    estimated: false,
  };

  await settleManagedFailureTerminal(ctx, { message: 'provider failed' }, {
    status: 'error', terminalSubcode: 'CMP-PROVIDER-0001', persistAssistantFailure: false,
  });

  assert.deepEqual(captured[0].terminal.rendererPayload.usage, ctx.turnUsage);
});
