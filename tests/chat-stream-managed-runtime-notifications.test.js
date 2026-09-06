// Behavioral coverage for the managed chat-stream notification dispatcher:
// handleNotification's per-method routing (chat.token, chat.thinking, batches,
// phases, reset, tools, done, error, gap candidate, unknown-method warn-once).
// Canonical-bridge + reasoning-delta paths live in the sibling -behavior file.
//
// Static-literal require (source->test existence gate walks this graph):
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');

const {
  INTERACTIVE_ERROR_CODES,
} = require('../services/backend/error-codes');
const {
  rebuildChatDoneUsage,
} = require('../services/backend/chat-stream-usage');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
} = require('./helpers/managed-runtime-notification-harness');

// ===========================================================================
// chat.token -> applyVisibleTextDelta
// ===========================================================================

test('chat.token accrues visible text and emits a response delta', () => {
  const ctx = makeCtx();
  handleNotification(ctx, { method: 'chat.token', params: { delta: 'Hello ' } }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });

  assert.equal(ctx.assistantText, 'Hello ');
  assert.equal(ctx.currentSegmentText, 'Hello ');
  assert.equal(ctx.streamSawText, true);

  const appended = callsOf(ctx, 'appendText');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].text, 'Hello ');

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].payload.type, 'delta');
  assert.equal(emits[0].payload.content, 'Hello ');
  assert.equal(emits[0].payload.aggregate, 'Hello ');
  assert.equal(emits[0].options.channel, 'response');
  // canonicalBridgeEnabled => a synthetic legacy sequence was assigned.
  assert.equal(ctx.legacyTextSequence, 1);
  // touchProgress fired.
  assert.equal(callsOf(ctx, 'touchActiveTurn').length, 1);
});

test('chat.token with empty delta is a no-op (applyVisibleTextDelta early return)', () => {
  const ctx = makeCtx();
  handleNotification(ctx, { method: 'chat.token', params: { delta: '' } }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });

  assert.equal(ctx.assistantText, '');
  assert.equal(ctx.streamSawText, false);
  assert.equal(callsOf(ctx, 'appendText').length, 0);
  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
});

test('chat.token after a question batch sets TEXT_AFTER_BATCH protocol error and emits nothing', () => {
  const ctx = makeCtx();
  ctx.streamSawBatch = true;
  handleNotification(ctx, { method: 'chat.token', params: { delta: 'late text' } }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });

  assert.ok(ctx.sidecarProtocolError instanceof Error);
  assert.match(ctx.sidecarProtocolError.message, new RegExp(INTERACTIVE_ERROR_CODES.TEXT_AFTER_BATCH));
  assert.equal(ctx.assistantText, '');
  assert.equal(callsOf(ctx, 'appendText').length, 0);
  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
});

test('chat.token deduplicates a repeated token sequence under the canonical bridge', () => {
  const ctx = makeCtx();
  // First token claims sequence 5.
  handleNotification(ctx, { method: 'chat.token', params: { delta: 'A', sequence: 5 } }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });
  // Same sequence again => deduped, no second append/emit.
  handleNotification(ctx, { method: 'chat.token', params: { delta: 'A', sequence: 5 } }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });

  assert.equal(ctx.assistantText, 'A');
  assert.equal(callsOf(ctx, 'appendText').length, 1);
  assert.equal(callsOf(ctx, 'emitChatStream').length, 1);
});

// ===========================================================================
// chat.thinking
// ===========================================================================

test('chat.thinking with kind=reasoning persists a reasoning entry via appendProviderReasoningDelta', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    {
      method: 'chat.thinking',
      params: { kind: 'reasoning', delta: 'Thinking hard.', thinking_id: 'think-Z', tokens_per_second: 12 },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.reasoningEntries.length, 1);
  assert.equal(ctx.reasoningEntries[0].text, 'Thinking hard.');
  assert.equal(callsOf(ctx, 'appendReasoningEntries').length, 1);
  assert.equal(callsOf(ctx, 'noteTurnEvent').length, 1);
  // persist path => no thinking status emitted.
  assert.equal(callsOf(ctx, 'emitThinkingStatus').length, 0);
});

test('chat.thinking non-persist status routes to emitThinkingStatus and records the phase id', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'chat.thinking', params: { kind: 'status', delta: 'Working...', thinking_id: 'phase-x' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.currentThinkingPhaseId, 'phase-x');
  const thinking = callsOf(ctx, 'emitThinkingStatus');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].delta, 'Working...');
  assert.equal(thinking[0].thinkingId, 'phase-x');
  // no persisted reasoning entry.
  assert.equal(ctx.reasoningEntries.length, 0);
  assert.equal(callsOf(ctx, 'appendReasoningEntries').length, 0);
});

test('chat.thinking with explicit persist=true persists even when kind is not reasoning', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'chat.thinking', params: { persist: true, kind: 'status', delta: 'A note.', thinking_id: 'tk-1' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.reasoningEntries.length, 1);
  assert.equal(callsOf(ctx, 'appendReasoningEntries').length, 1);
  assert.equal(callsOf(ctx, 'emitThinkingStatus').length, 0);
});

// ===========================================================================
// agent.progress
// ===========================================================================

test('agent.progress is dropped when the agent_executor flag is off', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.agent_executor = false;
  handleNotification(
    ctx,
    {
      method: 'agent.progress',
      params: {
        request_id: 'stream-1',
        session_id: 'session-1',
        task_id: 'task-1',
        task_type: 'build',
        agent_id: 'research@stream-1:call-1:1',
        parent_agent_id: 'main@stream-1',
        status: 'running',
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
});

test('agent.progress emits a control event when the agent_executor flag is on', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.agent_executor = true;
  handleNotification(
    ctx,
    {
      method: 'agent.progress',
      params: {
        request_id: 'stream-1',
        session_id: 'session-1',
        task_id: 'task-1',
        task_type: 'build',
        agent_id: 'research@stream-1:call-1:1',
        parent_agent_id: 'main@stream-1',
        status: 'running',
        stage: 'compiling',
        percent: 40,
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].options.channel, 'control');
  assert.equal(emits[0].payload.type, 'agent_status');
  assert.equal(emits[0].payload.taskId, 'task-1');
  assert.equal(emits[0].payload.stage, 'compiling');
  assert.equal(emits[0].payload.agentId, 'research@stream-1:call-1:1');
  assert.equal(emits[0].payload.parentAgentId, 'main@stream-1');
});

// ===========================================================================
// chat.question_batch
// ===========================================================================

test('chat.question_batch after visible text sets MIXED_TEXT_AND_BATCH and does not set a batch', () => {
  const ctx = makeCtx();
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    {
      method: 'chat.question_batch',
      params: { batch_id: 'b1', questions: [{ id: 'q1', prompt: 'Pick?', options: [{ id: 'o1', label: 'A' }] }] },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.ok(ctx.sidecarProtocolError instanceof Error);
  assert.match(ctx.sidecarProtocolError.message, new RegExp(INTERACTIVE_ERROR_CODES.MIXED_TEXT_AND_BATCH));
  assert.equal(ctx.streamSawBatch, false);
  assert.equal(ctx.questionBatch, null);
});

test('chat.question_batch with an invalid payload sets INVALID_BATCH_PAYLOAD', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'chat.question_batch', params: { batch_id: '', questions: [] } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.ok(ctx.sidecarProtocolError instanceof Error);
  assert.match(ctx.sidecarProtocolError.message, new RegExp(INTERACTIVE_ERROR_CODES.INVALID_BATCH_PAYLOAD));
  assert.equal(ctx.streamSawBatch, false);
});

test('chat.question_batch with a valid payload stores the normalized batch, flips streamSawBatch, and clears thinking status', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    {
      method: 'chat.question_batch',
      params: {
        batch: {
          batch_id: 'batch-42',
          questions: [{ id: 'q1', prompt: 'Choose one', options: [{ id: 'o1', label: 'Alpha' }, { id: 'o2', label: 'Beta' }] }],
        },
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.sidecarProtocolError, null);
  assert.equal(ctx.streamSawBatch, true);
  assert.ok(ctx.questionBatch);
  assert.equal(ctx.questionBatch.batch_id, 'batch-42');
  assert.equal(ctx.questionBatch.questions.length, 1);
  const thinking = callsOf(ctx, 'emitThinkingStatus');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].delta, '');
});

// ===========================================================================
// chat.phase_started / chat.phase_completed
// ===========================================================================

test('chat.phase_started notes the phase on the collector and emits a phase_started stream event', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    {
      method: 'chat.phase_started',
      params: {
        phase_id: 'ph-1',
        phase_kind: 'reasoning',
        iteration: 2,
        thinking_id: 'tk-1',
        summary: 'Drafting plan',
        tokens_per_second: 30,
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const started = callsOf(ctx, 'notePhaseStarted');
  assert.equal(started.length, 1);
  assert.equal(started[0].phase.phase_id, 'ph-1');
  assert.equal(started[0].phase.summary, 'Drafting plan');

  assert.ok(ctx.currentPhaseSnapshot);
  assert.equal(ctx.currentPhaseSnapshot.phaseId, 'ph-1');

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].payload.type, 'phase_started');
  assert.equal(emits[0].payload.phaseId, 'ph-1');
  assert.equal(emits[0].payload.tokensPerSecond, 30);
  assert.equal(emits[0].options.channel, 'phase');
});

test('chat.phase_completed notes completion on the collector and emits a phase_completed stream event', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    {
      method: 'chat.phase_completed',
      params: { phase_id: 'ph-2', phase_kind: 'tool_use', tool_name: 'read_file', summary: 'Read done' },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const completed = callsOf(ctx, 'notePhaseCompleted');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].phase.phase_id, 'ph-2');
  assert.equal(completed[0].phase.summary, 'Read done');

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].payload.type, 'phase_completed');
  assert.equal(emits[0].payload.toolName, 'read_file');
  assert.equal(emits[0].options.channel, 'phase');
});

// ===========================================================================
// chat.stream_reset
// ===========================================================================

test('chat.stream_reset discards persisted segments, clears accrued state, and emits a stream_reset control event', () => {
  const ctx = makeCtx();
  ctx.assistantText = 'partial';
  ctx.currentSegmentText = 'partial';
  ctx.streamSawText = true;
  ctx.streamSawBatch = true;
  ctx.reasoningEntries = [{ id: 'r0', text: 'x', timestamp: 't', thinkingId: '' }];
  ctx.appliedTextSequenceGate.note(1);
  ctx.canonicalToolStartedCallIds.add('call-1');
  ctx.lastReasoningEventPhaseKey = 'phase-x';
  ctx.legacyTextSequence = 5;
  ctx.transcriptCollector.turnHasVisibleText = true;
  const ordinalBefore = ctx.reasoningTurnEventOrdinal;

  handleNotification(ctx, { method: 'chat.stream_reset', params: {} }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });

  assert.equal(callsOf(ctx, 'discardPersistedTextSegmentsForReset').length, 1);
  const discarded = callsOf(ctx, 'discardCapturedEvents');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].streamId, 'stream-1');
  assert.deepEqual(discarded[0].kinds, ['assistant_text_segment', 'reasoning_phase']);

  assert.equal(ctx.assistantText, '');
  assert.equal(ctx.currentSegmentText, '');
  assert.equal(ctx.streamSawText, false);
  assert.equal(ctx.streamSawBatch, false);
  assert.deepEqual(ctx.reasoningEntries, []);
  assert.deepEqual(ctx.appliedTextSequenceGate.state(), { watermark: 0, gapSize: 0 });
  assert.equal(ctx.canonicalToolStartedCallIds.size, 0);
  assert.equal(ctx.lastReasoningEventPhaseKey, '');
  assert.equal(ctx.legacyTextSequence, 0);
  assert.equal(ctx.reasoningTurnEventOrdinal, ordinalBefore + 1);
  assert.equal(ctx.visibleAssistantMessageId, 'assistant-base-1');
  assert.equal(ctx.transcriptCollector.turnHasVisibleText, false);
  assert.equal(callsOf(ctx, 'resetSlice').length, 1);

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].payload.type, 'stream_reset');
  assert.equal(emits[0].options.channel, 'control');
});

test('chat.stream_reset reason=tool_continuation preserves segments + captured events when the display flag is on', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.response_loop_display_v2 = true;
  ctx.assistantText = 'partial';
  ctx.currentSegmentText = 'partial';
  ctx.streamSawText = true;
  ctx.reasoningEntries = [{ id: 'r0', text: 'x', timestamp: 't', thinkingId: '' }];
  ctx.canonicalToolStartedCallIds.add('call-1');
  ctx.hasPersistedSegments = true;
  const ordinalBefore = ctx.reasoningTurnEventOrdinal;

  handleNotification(
    ctx,
    { method: 'chat.stream_reset', params: { reason: 'tool_continuation' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
  );

  // The two destructive calls are SKIPPED: the benign pre-tool commentary
  // (already persisted at the tool boundary) and its captured turn events
  // survive the reset.
  assert.equal(callsOf(ctx, 'discardPersistedTextSegmentsForReset').length, 0);
  assert.equal(callsOf(ctx, 'discardCapturedEvents').length, 0);
  // The persisted segments stay live so finalize routes the final answer
  // through the multi-segment path instead of rewriting the base message.
  assert.equal(ctx.hasPersistedSegments, true);

  // The live tail buffer is still cleared (garbage lives there) and the
  // reasoning ordinal still advances so post-reset reasoning journals at all.
  assert.equal(ctx.assistantText, '');
  assert.equal(ctx.currentSegmentText, '');
  assert.deepEqual(ctx.reasoningEntries, []);
  assert.equal(ctx.streamSawText, false);
  assert.equal(ctx.canonicalToolStartedCallIds.size, 0);
  assert.equal(ctx.reasoningTurnEventOrdinal, ordinalBefore + 1);
  assert.equal(ctx.visibleAssistantMessageId, 'assistant-base-1');

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].payload.type, 'stream_reset');
});

for (const resetReason of ['model_winddown']) {
  test(`chat.stream_reset reason=${resetReason} preserves earlier segments and discards only the active slice events`, () => {
    const ctx = makeCtx();
    ctx.assistantText = 'replace this active slice';
    ctx.currentSegmentText = 'replace this active slice';
    ctx.hasPersistedSegments = true;
    ctx.streamSawText = true;

    handleNotification(
      ctx,
      { method: 'chat.stream_reset', params: { reason: resetReason } },
      { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
    );

    assert.equal(callsOf(ctx, 'discardPersistedTextSegmentsForReset').length, 0);
    assert.deepEqual(callsOf(ctx, 'discardCapturedEvents'), [{
      streamId: 'stream-1',
      kinds: ['assistant_text_segment', 'reasoning_phase'],
      options: { primaryMessageId: 'assistant-base-1' },
    }]);
    assert.equal(ctx.hasPersistedSegments, true);
    assert.equal(ctx.assistantText, '');
    assert.equal(ctx.currentSegmentText, '');
    assert.equal(ctx.streamSawText, false);
    assert.equal(callsOf(ctx, 'resetSlice').length, 1);
  });
}

// deterministic_replacement must DISCARD, not preserve. StreamResetEvent's
// contract (sidecar/ai/routing/loop_events.py) groups it with nudge_retry /
// post_tool_restart as a reset whose "discarded text is bad and must not
// survive"; tool_loop_finalize.py emits it when the model produced
// pseudo-search text for a lookup it could not run, and the loop then returns
// the real unavailability answer. Preserving those segments would leave the
// fabricated text in the transcript, and would also leave a pre-reset persist
// refusal latched -- see the settle-side pin in
// tests/chat-stream-durable-settlement.test.js.
test('chat.stream_reset reason=deterministic_replacement discards earlier segments (fabricated text must not survive)', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.response_loop_display_v2 = true;
  ctx.assistantText = 'pseudo-search text';
  ctx.currentSegmentText = 'pseudo-search text';
  ctx.hasPersistedSegments = true;
  ctx.streamSawText = true;

  handleNotification(
    ctx,
    { method: 'chat.stream_reset', params: { reason: 'deterministic_replacement' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
  );

  assert.equal(callsOf(ctx, 'discardPersistedTextSegmentsForReset').length, 1);
  assert.equal(ctx.hasPersistedSegments, false);
  assert.equal(ctx.segmentPersistRefused, false, 'the refusal latch clears with the discarded content');
  assert.equal(ctx.assistantText, '');
});

test('chat.stream_reset reason=tool_continuation still discards when the display flag is off (default)', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'chat.stream_reset', params: { reason: 'tool_continuation' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
  );
  assert.equal(callsOf(ctx, 'discardPersistedTextSegmentsForReset').length, 1);
  assert.equal(callsOf(ctx, 'discardCapturedEvents').length, 1);
});

for (const resetReason of ['nudge_retry', 'provider_retry', 'reflexive_retry']) {
  test(`chat.stream_reset reason=${resetReason} discards even when the display flag is on`, () => {
    const ctx = makeCtx();
    ctx.service.featureFlags.response_loop_display_v2 = true;
    ctx.assistantText = 'discard this failed attempt';
    ctx.currentSegmentText = 'discard this failed attempt';
    ctx.reasoningEntries = [{ id: 'r0', text: 'discard reasoning', timestamp: 't' }];
    handleNotification(
      ctx,
      { method: 'chat.stream_reset', params: { reason: resetReason } },
      { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
    );
    assert.equal(callsOf(ctx, 'discardPersistedTextSegmentsForReset').length, 1);
    assert.equal(callsOf(ctx, 'discardCapturedEvents').length, 1);
    assert.equal(ctx.assistantText, '');
    assert.deepEqual(ctx.reasoningEntries, []);
  });
}

test('chat.stream_reset reason=tool_continuation preserves even when the canonical bridge is off', () => {
  // 2026-07-06 completion-flicker RCA: canonical_bridge defaults OFF (the
  // canonical_m3_rollout canary), and gating preservation on it made every
  // default-config multi-tool turn discard its interim commentary/reasoning
  // from the store and the turn-event log — the terminal reconcile then
  // deleted the live rows the user had watched stream. tool_continuation
  // preservation now keys off response_loop_display_v2 alone.
  const ctx = makeCtx({ canonicalBridgeEnabled: false });
  ctx.service.featureFlags.response_loop_display_v2 = true;
  ctx.hasPersistedSegments = true;
  handleNotification(
    ctx,
    { method: 'chat.stream_reset', params: { reason: 'tool_continuation' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
  );
  assert.equal(callsOf(ctx, 'discardPersistedTextSegmentsForReset').length, 0);
  assert.equal(callsOf(ctx, 'discardCapturedEvents').length, 0);
  assert.equal(ctx.hasPersistedSegments, true);
});

test('chat.stream_reset forwards the sidecar reason to the renderer payload', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.response_loop_display_v2 = true;
  handleNotification(
    ctx,
    { method: 'chat.stream_reset', params: { reason: 'tool_continuation' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
  );
  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].payload.type, 'stream_reset');
  // The live reducer skips the "restarted" truncation stamp for preserved
  // tool_continuation resets — it needs the reason on the wire to do so.
  assert.equal(emits[0].payload.reason, 'tool_continuation');
});

// ===========================================================================
// tool.executing / tool.result (legacy notifications)
// ===========================================================================

test('legacy tool.executing notes a running step, persists the segment, and delegates to handleToolNotification', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  handleNotification(
    ctx,
    { method: 'tool.executing', params: { tool_call_id: 'leg-1', tool_name: 'shell' } },
    { toolContext: {}, handleToolNotification: handle }
  );

  assert.equal(ctx.unfinishedToolsSettled, false);
  assert.equal(callsOf(ctx, 'persistCurrentTextSegment').length, 1);

  const steps = callsOf(ctx, 'noteToolStep');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.status, 'running');
  assert.equal(steps[0].step.callId, 'leg-1');

  // recordLegacyNotification fired (not a turn.event).
  assert.equal(callsOf(ctx, 'recordLegacyNotification').length, 1);

  const handled = callsOf(ctx, 'handleToolNotification');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].notification.method, 'tool.executing');
});

test('legacy tool.executing for an already-canonical-started call short-circuits before noting a step', () => {
  const ctx = makeCtx();
  ctx.canonicalToolStartedCallIds.add('dupe-call');
  const handle = makeHandleToolNotification(ctx, false);
  const result = handleNotification(
    ctx,
    { method: 'tool.executing', params: { tool_call_id: 'dupe-call', tool_name: 'shell' } },
    { toolContext: {}, handleToolNotification: handle }
  );

  assert.equal(result, true);
  assert.equal(callsOf(ctx, 'noteToolStep').length, 0);
  assert.equal(callsOf(ctx, 'persistCurrentTextSegment').length, 0);
  assert.equal(callsOf(ctx, 'handleToolNotification').length, 0);
});

test('legacy tool.result notes a completed step and delegates the notification', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  handleNotification(
    ctx,
    { method: 'tool.result', params: { tool_call_id: 'leg-2', tool_name: 'shell', success: true } },
    { toolContext: {}, handleToolNotification: handle }
  );

  const steps = callsOf(ctx, 'noteToolStep');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.status, 'completed');

  const diag = callsOf(ctx, 'noteDiagnosticToolEvent');
  assert.equal(diag.length, 1);
  assert.equal(diag[0].payload.phase, 'result');

  const handled = callsOf(ctx, 'handleToolNotification');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].notification.method, 'tool.result');
  assert.deepEqual(ctx.toolResultCounts, { successful: 1, failed: 0 });
});

test('a tool notification claimed by handleToolNotification returns before the unknown-method check', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, true); // claimed
  const result = handleNotification(
    ctx,
    { method: 'tool.result', params: { tool_call_id: 'leg-3', tool_name: 'shell', success: false } },
    { toolContext: {}, handleToolNotification: handle }
  );

  assert.equal(result, undefined);
  // claimed => no unknown-method warn log.
  assert.equal(callsOf(ctx, 'serviceLog').filter((l) => l.code === 'chat.unknown_notification_method').length, 0);
  // error status step recorded.
  const steps = callsOf(ctx, 'noteToolStep');
  assert.equal(steps[0].step.status, 'error');
  assert.deepEqual(ctx.toolResultCounts, { successful: 0, failed: 1 });
});

// ===========================================================================
// unknown method warn-once
// ===========================================================================

test('an unknown notification method warns once and counts repeats without re-warning', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  const notif = { method: 'chat.mystery', params: {} };

  handleNotification(ctx, notif, { toolContext: {}, handleToolNotification: handle });
  handleNotification(ctx, notif, { toolContext: {}, handleToolNotification: handle });

  const warns = callsOf(ctx, 'serviceLog').filter((l) => l.code === 'chat.unknown_notification_method');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].fields.method, 'chat.mystery');
  assert.ok(ctx.unknownNotificationMethodCounts instanceof Map);
  assert.equal(ctx.unknownNotificationMethodCounts.get('chat.mystery'), 2);
});

// ===========================================================================
// context.compacted
// ===========================================================================

test('context.compacted emits a context_compacted control event with normalized counts', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    {
      method: 'context.compacted',
      params: { strategy: 'macro', tokens_before: 5000, tokens_after: 1200 },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].payload.type, 'context_compacted');
  assert.equal(emits[0].payload.strategy, 'macro');
  assert.equal(emits[0].payload.tokensBefore, 5000);
  assert.equal(emits[0].payload.tokensAfter, 1200);
  assert.equal(emits[0].options.channel, 'control');
});

// ===========================================================================
// context.usage (ephemeral mid-turn composer-ring snapshot)
// ===========================================================================

const CONTEXT_USAGE_PARAMS = Object.freeze({
  phase: 'iteration',
  iteration: 3,
  context_used_tokens: 42000,
  context_used_source: 'estimate',
  context_tokens_estimate: 42000,
  last_request_input_tokens: 900,
  context_window: 131072,
  compact_threshold_tokens: 61000,
  model: 'qwen',
  provider: 'ollama',
});

test('context.usage emits exactly one context_usage control event in the chat.done usage shape', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'context.usage', params: { ...CONTEXT_USAGE_PARAMS } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  const { payload, options } = emits[0];
  assert.equal(payload.type, 'context_usage');
  assert.equal(payload.phase, 'iteration');
  assert.equal(payload.iteration, 3);
  assert.equal(options.channel, 'control');
  // eventBase rides along so the renderer can scope the snapshot to its turn.
  assert.equal(payload.requestId, 'stream-1');
  // The usage block is rebuildChatDoneUsage's shape, so mid-turn and terminal
  // readings normalize through one path in the renderer.
  assert.deepEqual(payload.usage, rebuildChatDoneUsage(CONTEXT_USAGE_PARAMS, ctx.model));
  assert.equal(payload.usage.context_used_tokens, 42000);
  assert.equal(payload.usage.context_used_source, 'estimate');
  assert.equal(payload.usage.compact_threshold_tokens, 61000);
  assert.equal(payload.usage.context_window, 131072);
  assert.equal(payload.usage.model, 'qwen');
  // Ephemeral: the snapshot never becomes the turn's authoritative usage.
  assert.equal(ctx.turnUsage, null);
});

test('context.usage is a known method and never trips the unknown-method warning', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'context.usage', params: { ...CONTEXT_USAGE_PARAMS } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const warns = callsOf(ctx, 'serviceLog').filter((l) => l.code === 'chat.unknown_notification_method');
  assert.equal(warns.length, 0);
});

test('context.usage is dropped when the context_usage_live kill switch is off', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags = { context_usage_live: false };
  handleNotification(
    ctx,
    { method: 'context.usage', params: { ...CONTEXT_USAGE_PARAMS } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
  const warns = callsOf(ctx, 'serviceLog').filter((l) => l.code === 'chat.unknown_notification_method');
  assert.equal(warns.length, 0, 'a deliberate flag-off drop is not protocol drift');
});

// ===========================================================================
// chat.done
// ===========================================================================

test('chat.done with usage and a successful stop reason captures usage, settles tools, and begins finalization', () => {
  const ctx = makeCtx();
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: {
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10, output_tokens: 20, total_tokens: 30,
          generation_tokens: 20, generation_duration_ms: 800,
          prompt_eval_duration_ms: 125, load_duration_ms: 50,
          time_to_first_token_ms: 90, estimated: true,
          cost_usd: 0.5, cost_source: 'provider', provider: 'cloud',
        },
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.ok(ctx.turnUsage);
  assert.equal(ctx.turnUsage.input_tokens, 10);
  assert.equal(ctx.turnUsage.output_tokens, 20);
  assert.equal(ctx.turnUsage.cost_usd, 0.5);
  assert.equal(ctx.turnUsage.cost_source, 'provider');
  assert.equal(ctx.turnUsage.provider, 'cloud');
  assert.equal(ctx.turnUsage.generation_tokens, 20);
  assert.equal(ctx.turnUsage.generation_duration_ms, 800);
  assert.equal(ctx.turnUsage.prompt_eval_duration_ms, 125);
  assert.equal(ctx.turnUsage.load_duration_ms, 50);
  assert.equal(ctx.turnUsage.time_to_first_token_ms, 90);
  assert.equal(ctx.turnUsage.estimated, true);
  // No window reported => forwarded as 0 so the renderer falls back cleanly.
  assert.equal(ctx.turnUsage.context_window, 0);

  const settled = callsOf(ctx, 'settleUnfinishedToolRows');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].reason, 'chat_done');

  assert.equal(callsOf(ctx, 'beginVisibleCompletionFinalization').length, 1);
  // success path => no terminal error recorded.
  assert.equal(callsOf(ctx, 'recordSidecarErrorFromParams').length, 0);
  assert.equal(ctx.sidecarDoneTerminalError, null);
});

test('chat.done applies nonblank terminal response text before finalization', () => {
  const ctx = makeCtx();

  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: {
        stop_reason: 'end_turn',
        response_text: 'Deterministic fallback.',
        completion_source: 'deterministic_tool_fallback',
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.assistantText, 'Deterministic fallback.');
  assert.equal(ctx.streamSawText, true);
  assert.deepEqual(callsOf(ctx, 'applyAuthoritativeTerminalText'), [{
    content: 'Deterministic fallback.',
    completionSource: 'deterministic_tool_fallback',
    authoritySource: 'chat_done',
  }]);
  assert.equal(callsOf(ctx, 'beginVisibleCompletionFinalization').length, 1);
});

test('chat.done forwards the sidecar context_window into turnUsage (renderer meter denominator)', () => {
  // Contract guard for the context-meter denominator: the sidecar nests the
  // loaded model's true window under usage.context_window
  // (chat_helpers.attach_context_window). The field-by-field turnUsage rebuild
  // must preserve it, or the renderer ring silently falls back to its static
  // guessContextLimit table (and renders nothing for table-unknown / custom
  // num_ctx models). This previously regressed unnoticed because the renderer
  // unit test exercised a payload shape the backend never actually produced.
  const ctx = makeCtx();
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: {
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          context_tokens_estimate: 18_000,
          context_window: 40_960,
          model: 'qwen3.6:35b',
          provider: 'local',
        },
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.ok(ctx.turnUsage);
  assert.equal(ctx.turnUsage.context_window, 40_960);
  assert.equal(ctx.turnUsage.context_tokens_estimate, 18_000);
  assert.equal(ctx.turnUsage.model, 'qwen3.6:35b');
});

test('chat.done forwards provider-truth meter fields into turnUsage (numerator + denominator)', () => {
  // Contract guard for the Ollama meter work: last_request_input_tokens (the
  // overwrite-not-add "current request size") and compact_threshold_tokens
  // (the sidecar's auto-compaction trigger) must survive the field-by-field
  // turnUsage rebuild, or the renderer ring silently drops back to char
  // estimates against the raw window.
  const ctx = makeCtx();
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: {
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 240,
          output_tokens: 20,
          total_tokens: 260,
          last_request_input_tokens: 140,
          compact_threshold_tokens: 95_846,
          context_window: 131_072,
          model: 'qwen3.6:35b',
          provider: 'ollama',
        },
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.ok(ctx.turnUsage);
  assert.equal(ctx.turnUsage.last_request_input_tokens, 140);
  assert.equal(ctx.turnUsage.compact_threshold_tokens, 95_846);
});

test('chat.done rejects malformed provider cost and forces local cost to zero', () => {
  for (const costUsd of [-1, null, '', false, '0']) {
    const providerCtx = makeCtx();
    handleNotification(providerCtx, {
      method: 'chat.done',
      params: { usage: { cost_source: 'provider', cost_usd: costUsd } },
    }, { toolContext: {}, handleToolNotification: makeHandleToolNotification(providerCtx) });
    assert.equal(providerCtx.turnUsage.cost_source, 'unavailable');
    assert.equal(providerCtx.turnUsage.cost_usd, null);
  }

  const explicitZeroCtx = makeCtx();
  handleNotification(explicitZeroCtx, {
    method: 'chat.done',
    params: { usage: { cost_source: 'provider', cost_usd: 0 } },
  }, { toolContext: {}, handleToolNotification: makeHandleToolNotification(explicitZeroCtx) });
  assert.equal(explicitZeroCtx.turnUsage.cost_source, 'provider');
  assert.equal(explicitZeroCtx.turnUsage.cost_usd, 0);

  const localCtx = makeCtx();
  handleNotification(localCtx, {
    method: 'chat.done',
    params: { usage: { cost_source: 'local_zero', cost_usd: 9 } },
  }, { toolContext: {}, handleToolNotification: makeHandleToolNotification(localCtx) });
  assert.equal(localCtx.turnUsage.cost_source, 'local_zero');
  assert.equal(localCtx.turnUsage.cost_usd, 0);
});

test('chat.done without the meter fields forwards zeros so the renderer falls back cleanly', () => {
  const ctx = makeCtx();
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: {
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, provider: 'local' },
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.ok(ctx.turnUsage);
  assert.equal(ctx.turnUsage.last_request_input_tokens, 0);
  assert.equal(ctx.turnUsage.compact_threshold_tokens, 0);
  assert.equal(ctx.turnUsage.generation_tokens, undefined);
  assert.equal(ctx.turnUsage.generation_duration_ms, undefined);
  assert.equal(ctx.turnUsage.time_to_first_token_ms, undefined);
  assert.equal(ctx.turnUsage.estimated, false);
});

test('chat.done with a non-success stop reason records a terminal error and clears thinking status', () => {
  const ctx = makeCtx();
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    { method: 'chat.done', params: { stop_reason: 'error' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const settled = callsOf(ctx, 'settleUnfinishedToolRows');
  assert.equal(settled.length, 1);

  const recorded = callsOf(ctx, 'recordSidecarErrorFromParams');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].opts.stopReason, 'error');
  assert.equal(recorded[0].opts.retryable, false);
  assert.equal(ctx.sidecarDoneTerminalError, ctx._SENTINEL_SIDECAR_ERROR);

  assert.equal(callsOf(ctx, 'emitThinkingStatus').length, 1);
  // terminal error path => finalization NOT begun.
  assert.equal(callsOf(ctx, 'beginVisibleCompletionFinalization').length, 0);
});

// ===========================================================================
// chat.error
// ===========================================================================

test('chat.error records the sidecar error from params', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'chat.error', params: { error_code: 'CMP-AI-0002', message: 'boom' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const recorded = callsOf(ctx, 'recordSidecarErrorFromParams');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].params.error_code, 'CMP-AI-0002');
  assert.equal(recorded[0].params.message, 'boom');
});

// ===========================================================================
// runtime.gap_candidate
// ===========================================================================

test('runtime.gap_candidate emits a runtime-gap-candidate service event carrying the params payload', () => {
  const ctx = makeCtx();
  const params = {
    schema_version: 1,
    reason_code: 'STALL',
    detector_id: 'det-1',
    occurrence_id: 'occ-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
  };
  handleNotification(
    ctx,
    { method: 'runtime.gap_candidate', params },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const emitted = callsOf(ctx, 'serviceEmit').filter((e) => e.eventName === 'runtime-gap-candidate');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.payload, params);
  assert.equal(emitted[0].payload.requestId, 'stream-1');
});
