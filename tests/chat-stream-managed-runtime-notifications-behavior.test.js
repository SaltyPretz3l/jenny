// Behavioral coverage (part 2) for the managed chat-stream notification
// dispatcher: the canonical turn.event bridge (text_delta, text_part_completed,
// reasoning_delta, tool notifications, canonicalToolNotification null) and the
// appendProviderReasoningDelta redacted/truncated/no-entry/protocol-violation
// branches. Per-method routing lives in the sibling .test.js file.
//
// Static-literal require (source->test existence gate walks this graph):
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');

const {
  CHAT_PROTOCOL_ERROR_CODES,
} = require('../services/backend/error-codes');
const { workspaceRootId } = require('../services/workspace-root-identity');

const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
  canonicalEvent,
} = require('./helpers/managed-runtime-notification-harness');

// ===========================================================================
// turn.event metrics + dropped accounting + bridge dispatch
// ===========================================================================

test('turn.event records a canonical event and latency, then bridges text_delta to a response delta', () => {
  const ts = new Date(Date.now() - 50).toISOString();
  const ctx = makeCtx();
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      params: canonicalEvent('text_delta', { delta: 'Bridged' }, { ts, seq: 3 }),
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  // metrics: canonical recorded, legacy NOT, latency recorded (finite ts).
  assert.equal(callsOf(ctx, 'recordCanonicalEvent').length, 1);
  assert.equal(callsOf(ctx, 'recordLegacyNotification').length, 0);
  const latency = callsOf(ctx, 'recordLatency');
  assert.equal(latency.length, 1);
  assert.equal(latency[0].name, 'sidecar_notification_to_electron_ms');
  // ts was set ~50ms in the past, so the recorded elapsed-time must be a finite
  // positive value in that neighbourhood. `>= 0` alone is vacuous: the source
  // clamps with Math.max(..., 0), so it can never go negative no matter how
  // wrong the elapsed-time math is. Pin it to the real ~50ms gap instead.
  assert.equal(Number.isFinite(latency[0].value), true);
  assert.ok(latency[0].value > 0, 'elapsed-time math must run, not just the clamp');
  assert.ok(latency[0].value < 60000, 'latency must reflect the ~50ms gap, not garbage');

  // the collector saw the event (captured truthy => no drop).
  assert.equal(callsOf(ctx, 'noteEvent').length, 1);
  assert.equal(callsOf(ctx, 'recordDroppedCanonicalEvent').length, 0);

  // bridged text applied.
  assert.equal(ctx.assistantText, 'Bridged');
  assert.equal(callsOf(ctx, 'appendText').length, 1);
});

test('turn.event with an invalid envelope records a dropped canonical event and skips the bridge', () => {
  const ctx = makeCtx();
  // version mismatch => validation.status !== 'accepted'.
  handleNotification(
    ctx,
    { method: 'turn.event', params: { v: 99, turn_id: 'turn-1', seq: 1, type: 'text_delta', payload: { delta: 'x' } } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(callsOf(ctx, 'recordDroppedCanonicalEvent').length, 1);
  // not accepted => no bridge application.
  assert.equal(ctx.assistantText, '');
  assert.equal(callsOf(ctx, 'appendText').length, 0);
});

test('turn.event records a dropped event when the collector declines to capture a durable kind', () => {
  const ctx = makeCtx();
  ctx.turnEventCollector.noteEvent = (params, meta) => {
    ctx._calls.noteEvent.push({ params, meta });
    return null; // not captured
  };
  // text_part_completed is a durable type that reduceToTurnEventKind maps.
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      params: canonicalEvent('text_part_completed', { text: 'Done text' }, { seq: 2 }),
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(callsOf(ctx, 'recordDroppedCanonicalEvent').length, 1);
  // accepted => still bridged: assistantText was empty so the whole text applies.
  assert.equal(ctx.assistantText, 'Done text');
});

// ===========================================================================
// applyCanonicalBridgeEvent: text_part_completed branches
// ===========================================================================

test('bridge text_part_completed applies the full text when no visible text yet', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'turn.event', params: canonicalEvent('text_part_completed', { text: 'Full answer' }) },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.assistantText, 'Full answer');
  const appended = callsOf(ctx, 'appendText');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].text, 'Full answer');
});

test('bridge text_part_completed appends only the suffix when it extends existing text', () => {
  const ctx = makeCtx();
  ctx.assistantText = 'Hello';
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    { method: 'turn.event', params: canonicalEvent('text_part_completed', { text: 'Hello world' }) },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.assistantText, 'Hello world');
  const appended = callsOf(ctx, 'appendText');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].text, ' world');
});

test('bridge text_part_completed that neither matches nor extends is a no-op accept', () => {
  const ctx = makeCtx();
  ctx.assistantText = 'Original';
  ctx.streamSawText = true;
  handleNotification(
    ctx,
    { method: 'turn.event', params: canonicalEvent('text_part_completed', { text: 'Divergent' }) },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  // unchanged; no append, no emit beyond metrics.
  assert.equal(ctx.assistantText, 'Original');
  assert.equal(callsOf(ctx, 'appendText').length, 0);
  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
});

// ===========================================================================
// applyCanonicalBridgeEvent: reasoning_delta -> appendProviderReasoningDelta
// ===========================================================================

test('bridge reasoning_delta persists an entry, notes a reasoning_phase turn event, and emits a reasoning delta', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      params: canonicalEvent('reasoning_delta', {
        delta: 'Considering the approach.',
        thinking_id: 'think-A',
        summary: 'planning',
      }),
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  // reasoning entry coalesced into ctx.reasoningEntries.
  assert.equal(ctx.reasoningEntries.length, 1);
  assert.equal(ctx.reasoningEntries[0].text, 'Considering the approach.');
  assert.equal(ctx.lastReasoningThinkingId, 'think-A');

  // collector received the entry.
  const collector = callsOf(ctx, 'appendReasoningEntries');
  assert.equal(collector.length, 1);
  assert.equal(collector[0].meta.thinking_id, 'think-A');

  // one reasoning_phase turn event.
  const turnEvents = callsOf(ctx, 'noteTurnEvent');
  assert.equal(turnEvents.length, 1);
  assert.equal(turnEvents[0].kind, 'reasoning_phase');
  assert.equal(turnEvents[0].event.payload.phase_kind, 'reasoning');
  assert.equal(turnEvents[0].event.payload.thinking_id, 'think-A');

  // reasoning-channel delta emitted.
  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].options.channel, 'reasoning');
  assert.equal(emits[0].payload.reasoning.source, 'provider');
});

test('bridge reasoning_delta with empty delta does nothing', () => {
  const ctx = makeCtx();
  handleNotification(
    ctx,
    { method: 'turn.event', params: canonicalEvent('reasoning_delta', { delta: '', thinking_id: 'think-A' }) },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.reasoningEntries.length, 0);
  assert.equal(callsOf(ctx, 'appendReasoningEntries').length, 0);
  assert.equal(callsOf(ctx, 'noteTurnEvent').length, 0);
});

test('bridge reasoning_delta deduplicates the paired legacy reasoning chunk', () => {
  const ctx = makeCtx();
  const dependencies = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };
  handleNotification(ctx, {
    method: 'chat.thinking',
    params: { kind: 'reasoning', persist: true, delta: 'Same chunk', thinking_id: 'think-paired' },
  }, dependencies);
  handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('reasoning_delta', {
      delta: 'Same chunk', thinking_id: 'think-paired', persist: true,
    }),
  }, dependencies);

  assert.equal(ctx.reasoningEntries.length, 1);
  assert.equal(ctx.reasoningEntries[0].text, 'Same chunk');
  assert.equal(callsOf(ctx, 'appendReasoningEntries').length, 1);
});

test('persisted reasoning correlation id overrides a prior status id', () => {
  const ctx = makeCtx();
  const dependencies = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };
  handleNotification(ctx, {
    method: 'chat.thinking',
    params: { kind: 'status', persist: false, delta: 'Working', thinking_id: 'status-1' },
  }, dependencies);
  handleNotification(ctx, {
    method: 'chat.thinking',
    params: { kind: 'reasoning', persist: true, delta: 'Reason', thinking_id: 'reason-2' },
  }, dependencies);

  assert.equal(ctx.reasoningEntries[0].thinkingId, 'reason-2');
  assert.equal(callsOf(ctx, 'appendReasoningEntries')[0].meta.thinking_id, 'reason-2');
});

// ===========================================================================
// applyCanonicalBridgeEvent: tool notifications (executing/result/null)
// ===========================================================================

test('bridge tool_execution_started notes a running step, persists the segment, and delegates to handleToolNotification', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      params: canonicalEvent('tool_execution_started', {
        tool_call_id: 'call-7',
        tool_name: 'read_file',
        tool_input: { path: 'x.txt' },
      }),
    },
    { toolContext: { seenToolCalls: new Set() }, handleToolNotification: handle }
  );

  assert.equal(ctx.canonicalToolStartedCallIds.has('call-7'), true);
  assert.equal(ctx.unfinishedToolsSettled, false);

  const persisted = callsOf(ctx, 'persistCurrentTextSegment');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].opts.allowReasoningOnly, true);

  const diag = callsOf(ctx, 'noteDiagnosticToolEvent');
  assert.equal(diag.length, 1);
  assert.equal(diag[0].payload.callId, 'call-7');
  assert.equal(diag[0].payload.phase, 'executing');

  const steps = callsOf(ctx, 'noteToolStep');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.status, 'running');
  assert.equal(steps[0].step.toolName, 'read_file');

  const handled = callsOf(ctx, 'handleToolNotification');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].notification.method, 'tool.executing');
  assert.equal(handled[0].notification.params.tool_call_id, 'call-7');
});

test('bridge tool_execution_started is skipped when the tool call was already projected', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  const seen = new Set(['call-7']);
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      params: canonicalEvent('tool_execution_started', {
        tool_call_id: 'call-7',
        tool_name: 'read_file',
      }),
    },
    { toolContext: { seenToolCalls: seen }, handleToolNotification: handle }
  );

  // short-circuited: no step, no diag, no delegation.
  assert.equal(callsOf(ctx, 'noteToolStep').length, 0);
  assert.equal(callsOf(ctx, 'noteDiagnosticToolEvent').length, 0);
  assert.equal(callsOf(ctx, 'handleToolNotification').length, 0);
});

test('bridge tool_execution_completed notes a completed step and delegates a tool.result notification', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  const workspaceRoot = 'G:/managed-notification-origin';
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      params: canonicalEvent('tool_execution_completed', {
        tool_call_id: 'call-9',
        tool_name: 'write_file',
        success: true,
        output: 'wrote ok',
        metadata: { diff: { path: 'src/app.js' } },
      }),
    },
    { toolContext: { workspaceRoot }, handleToolNotification: handle }
  );

  const diag = callsOf(ctx, 'noteDiagnosticToolEvent');
  assert.equal(diag.length, 1);
  assert.equal(diag[0].payload.phase, 'result');

  const steps = callsOf(ctx, 'noteToolStep');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.status, 'completed');

  const handled = callsOf(ctx, 'handleToolNotification');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].notification.method, 'tool.result');
  assert.equal(handled[0].notification.params.success, true);
  assert.equal(
    handled[0].notification.params.metadata.workspace_id,
    workspaceRootId(workspaceRoot)
  );
  assert.equal(
    callsOf(ctx, 'noteEvent')[0].params.payload.metadata.workspace_id,
    workspaceRootId(workspaceRoot)
  );
});

test('bridge tool_execution_failed notes an error step', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      params: canonicalEvent('tool_execution_failed', {
        tool_call_id: 'call-11',
        tool_name: 'shell',
        error_code: 'CMP-TOOL-0008',
      }),
    },
    { toolContext: {}, handleToolNotification: handle }
  );

  const steps = callsOf(ctx, 'noteToolStep');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.status, 'error');

  const handled = callsOf(ctx, 'handleToolNotification');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].notification.method, 'tool.result');
  // failed => success false.
  assert.equal(handled[0].notification.params.success, false);
});

test('bridge canonical tool event without a callId/toolName is not a tool notification (canonicalToolNotification null)', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx, false);
  handleNotification(
    ctx,
    {
      method: 'turn.event',
      // tool_execution_started but payload has no tool_call_id / tool_name.
      params: canonicalEvent('tool_execution_started', { irrelevant: true }),
    },
    { toolContext: {}, handleToolNotification: handle }
  );

  assert.equal(callsOf(ctx, 'noteToolStep').length, 0);
  assert.equal(callsOf(ctx, 'noteDiagnosticToolEvent').length, 0);
  assert.equal(callsOf(ctx, 'handleToolNotification').length, 0);
});

// ===========================================================================
// appendProviderReasoningDelta: truncated / no-entry / violation
// (driven through chat.thinking kind=reasoning). NOTE: redacted/truncated/entry
// come from the REAL appendPersistedReasoningEntry (a static-require helper, not
// an injected collaborator), so these drive the real persistence budget; only
// protocolViolation/phase come from the injected transcriptCollector.
// ===========================================================================

test('reasoning delta logs chat.reasoning_truncated when the real entry budget is exhausted', () => {
  const ctx = makeCtx();
  // Fill to the 40-entry max (MAX_PERSISTED_REASONING_ENTRIES) so the next
  // non-coalescing append (phase change => coalesceTail:false) hits the cap and
  // appendPersistedReasoningEntry returns { truncated: true, entry: null }.
  ctx.reasoningEntries = Array.from({ length: 40 }, (_unused, index) => ({
    id: `reasoning_${index}`,
    text: `prior reasoning chunk number ${index}`,
    timestamp: '2026-06-14T00:00:00.000Z',
    thinkingId: 'think-prior',
  }));
  ctx.lastReasoningThinkingId = 'think-prior';
  handleNotification(
    ctx,
    { method: 'chat.thinking', params: { kind: 'reasoning', delta: 'one more chunk', thinking_id: 'think-new' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  const logs = callsOf(ctx, 'serviceLog').filter((l) => l.code === 'chat.reasoning_truncated');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].fields.reasoningEntryCount, 40);
  // capped append => no entry => collector + turn-event path skipped.
  assert.equal(callsOf(ctx, 'appendReasoningEntries').length, 0);
  assert.equal(callsOf(ctx, 'noteTurnEvent').length, 0);
});

test('reasoning delta returns early when the sanitized text is empty (no persisted entry)', () => {
  const ctx = makeCtx();
  // Non-empty raw delta clears the first guard, but the real sanitizer strips
  // the <think> wrapper to empty => appendPersistedReasoningEntry yields no entry.
  handleNotification(
    ctx,
    { method: 'chat.thinking', params: { kind: 'reasoning', delta: '<think></think>', thinking_id: 'think-N' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ctx.reasoningEntries.length, 0);
  // With no entry the collector turn-event + emit path is skipped.
  assert.equal(callsOf(ctx, 'appendReasoningEntries').length, 0);
  assert.equal(callsOf(ctx, 'noteTurnEvent').length, 0);
  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
});

test('reasoning delta sets REASONING_AFTER_VISIBLE protocol error when the collector reports a violation', () => {
  const ctx = makeCtx();
  ctx._setAppendReasoningResult(() => ({
    protocolViolation: true,
    entry: { id: 'r0', text: 'late reasoning', timestamp: 't', thinkingId: 'think-V' },
  }));
  handleNotification(
    ctx,
    { method: 'chat.thinking', params: { kind: 'reasoning', delta: 'late reasoning', thinking_id: 'think-V' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.ok(ctx.sidecarProtocolError instanceof Error);
  assert.equal(ctx.sidecarProtocolError.error_code, CHAT_PROTOCOL_ERROR_CODES.REASONING_AFTER_VISIBLE);
  // violation returns before any turn event / emit.
  assert.equal(callsOf(ctx, 'noteTurnEvent').length, 0);
  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
});
