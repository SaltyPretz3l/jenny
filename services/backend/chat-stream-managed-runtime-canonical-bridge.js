// The canonical `turn.event` path of the managed-runtime notification router:
// identity stamping, validation and capture, then the projection of canonical
// text/reasoning/tool events onto the legacy visible-text and tool surfaces.
// Split out of chat-stream-managed-runtime-notifications.js (still the entry
// point); handlers receive the same explicit ctx.
const {
  normalizeRuntimeToken,
  normalizeRuntimeNumber,
  textSequenceKey,
} = require('./chat-stream-managed-runtime-utils');
const {
  appendProviderReasoningDelta,
  buildAggregateCheckpointFields,
  isPairedReasoningDelta,
} = require('./chat-stream-reasoning-delta');
const {
  reduceToTurnEventKind,
  validateTurnEvent,
} = require('./canonical-turn-event');
const { attachWorkspaceIdentityToCanonicalEvent, mergeLocalGeneratedArtifactPaths, opensNewToolRow } = require('./chat-stream-tool-payload-utils');
const { withIngestedAttachmentRefs } = require('./tool-result-attachments');
const {
  buildStreamToolResultMessageId,
  buildStreamToolUseMessageId,
} = require('./tool-message-id');
const {
  INTERACTIVE_ERROR_CODES,
} = require('./error-codes');
const {
  noteBackgroundJobFromToolResult,
} = require('./chat-stream-background-jobs');

function canonicalToolNotification(ctx, event) {
  const { streamId, resolvedSessionId } = ctx;
  const eventType = normalizeRuntimeToken(event?.type);
  const payload = event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const callId = normalizeRuntimeToken(event?.tool_call_id || payload.tool_call_id || payload.toolCallId);
  const toolName = normalizeRuntimeToken(payload.tool_name || payload.toolName);
  if (!callId || !toolName) {
    return null;
  }
  const common = {
    request_id: streamId,
    requestId: streamId,
    stream_id: streamId,
    streamId,
    session_id: resolvedSessionId,
    sessionId: resolvedSessionId,
    tool_name: toolName,
    tool_call_id: callId,
    tool_input: payload.tool_input || payload.input || {},
  };
  if (eventType === 'tool_call_requested' || eventType === 'tool_execution_started') {
    return {
      method: eventType === 'tool_call_requested' ? 'tool.requested' : 'tool.executing',
      params: common,
    };
  }
  if (eventType === 'tool_execution_completed' || eventType === 'tool_execution_failed') {
    const success = eventType === 'tool_execution_completed' && payload.success !== false;
    return {
      method: 'tool.result',
      params: {
        ...common,
        success,
        output: String(payload.tool_output_summary || payload.output_text || payload.output || ''),
        content_type: normalizeRuntimeToken(payload.content_type) || 'text',
        ...(payload.ui_payload != null ? { ui_payload: payload.ui_payload } : {}),
        ...(Array.isArray(payload.generated_artifacts) ? { generated_artifacts: payload.generated_artifacts } : {}),
        ...(payload.error_code ? { error_code: payload.error_code } : {}),
        ...(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? { metadata: payload.metadata }
          : {}),
        ...(payload.duration_ms != null ? { duration_ms: payload.duration_ms } : {}),
      },
    };
  }
  return null;
}

function applyVisibleTextDelta(ctx, tokenDelta, params = {}, options = {}) {
  const { service, streamId, resolvedSessionId, transcriptCollector, emitChatStream } = ctx;
  const text = String(tokenDelta || '');
  if (!text) {
    return false;
  }
  const sequenceValue = params.sequence ?? params.tokenSequence;
  const shouldDedupeSequence = options.dedupeBySequence === true
    && Boolean(textSequenceKey(sequenceValue));
  if (shouldDedupeSequence && !ctx.appliedTextSequenceGate.shouldApply(sequenceValue)) {
    return false;
  }
  if (ctx.streamSawBatch) {
    ctx.sidecarProtocolError = new Error(
      `${INTERACTIVE_ERROR_CODES.TEXT_AFTER_BATCH} Interactive protocol error: received text after question batch.`
    );
    return false;
  }
  ctx.streamSawText = true;
  ctx.assistantText += text;
  ctx.currentSegmentText += text;
  transcriptCollector.appendText(text, {
    timestamp: params.timestamp || new Date().toISOString(),
  });
  if (shouldDedupeSequence) {
    const gapOverflowed = ctx.appliedTextSequenceGate.note(sequenceValue);
    if (
      gapOverflowed
      && ctx.textSequenceGapOverflowWarned !== true
      && typeof service._emitServiceLog === 'function'
    ) {
      ctx.textSequenceGapOverflowWarned = true;
      service._emitServiceLog('WARN', 'chat.text_sequence_gap_overflow', {
        sessionId: resolvedSessionId,
        streamId,
        model: ctx.model,
        ...ctx.appliedTextSequenceGate.state(),
      });
    }
  }
  const tokenSequence = normalizeRuntimeNumber(sequenceValue);
  const assistantText = ctx.assistantText;
  emitChatStream({
    type: 'delta',
    content: text,
    ...buildAggregateCheckpointFields(ctx, assistantText, {
      forceCheckpoint: options.forceAggregateCheckpoint === true,
    }),
    ...(tokenSequence != null ? { tokenSequence } : {}),
    ...ctx.eventBase,
  }, {
    channel: 'response',
  });
  return true;
}

// The renderer's activity row only needs the call's cumulative size plus the
// first few KB (to spot a path), so provider-rate fragments are folded into at
// most one control event per TOOL_INPUT_FORWARD_INTERVAL_MS. Envelope kind
// 'progress' passes 1:1, which is exactly why this must not forward per chunk
// (a 32 KiB write would otherwise be thousands of IPC sends). Nothing trails
// (a followed file below is the exception): the row is replaced by the
// tool_use event that follows the last fragment.
const TOOL_INPUT_PREVIEW_CHARS = 4096;
// Checklist writes (FG-006) show the item being written and the running item
// count, so the row reads their whole argument text. Todo lists and task-board
// entries stay small; the per-interval fold still caps the IPC rate.
const CHECKLIST_TOOL_INPUT_PREVIEW_CHARS = 32768;
const CHECKLIST_TOOL_NAMES = new Set(['todo_write', 'task_board']);
const TOOL_INPUT_FORWARD_INTERVAL_MS = 100;
// Follow Jenny (row 121): Workspace shows a file while the model writes it, so
// the file tools forward their whole argument text, still folded to one event
// per interval, and flush the last fragment before the tool event that ends it
// (the draft is what an approval card asks about, so it must not stop short).
// Their interval is shorter: the text is watched as it arrives, and ten steps a
// second read as stutter (owner's live run, 2026-11-09).
const FOLLOW_TOOL_INPUT_PREVIEW_CHARS = 524288;
const FOLLOW_TOOL_INPUT_FORWARD_INTERVAL_MS = 50;
const FOLLOW_TOOL_NAMES = new Set(['write_file', 'edit_file']);

function emitToolInputForward(ctx, forward) {
  ctx.emitChatStream({
    type: 'tool_input_delta',
    toolCallId: forward.toolCallId,
    toolName: forward.toolName,
    argumentsDelta: forward.pending,
    argumentsBytes: forward.bytes,
    sequence: forward.sequence,
    ...ctx.eventBase,
  }, { channel: 'control' });
  forward.shippedChars += forward.pending.length;
  forward.pending = '';
}

function forwardToolInputDelta(ctx, event, payload) {
  const toolCallId = String(event.tool_call_id || '');
  const delta = String(payload.arguments_delta || '');
  let forward = ctx.toolInputForward;
  if (!forward || forward.toolCallId !== toolCallId) {
    flushToolInputTail(ctx); // the previous call's folded tail, before this call replaces it
    const toolName = String(payload.tool_name || '');
    const follow = FOLLOW_TOOL_NAMES.has(toolName) && ctx.service?.featureFlags?.follow_jenny === true;
    let previewChars = TOOL_INPUT_PREVIEW_CHARS;
    if (follow) previewChars = FOLLOW_TOOL_INPUT_PREVIEW_CHARS;
    else if (CHECKLIST_TOOL_NAMES.has(toolName)) previewChars = CHECKLIST_TOOL_INPUT_PREVIEW_CHARS;
    forward = {
      toolCallId, toolName, bytes: 0, shippedChars: 0, pending: '', lastEmitAt: 0, sequence: 0,
      previewChars, flushTail: follow,
      intervalMs: follow ? FOLLOW_TOOL_INPUT_FORWARD_INTERVAL_MS : TOOL_INPUT_FORWARD_INTERVAL_MS,
    };
    ctx.toolInputForward = forward;
  }
  forward.bytes += Buffer.byteLength(delta, 'utf8');
  forward.sequence = Number.isFinite(Number(payload.sequence)) ? Number(payload.sequence) : 0;
  const previewRoom = forward.previewChars - forward.shippedChars - forward.pending.length;
  if (previewRoom > 0) forward.pending += delta.slice(0, previewRoom);
  const nowMs = typeof ctx.now === 'function' ? Number(ctx.now()) : Date.now();
  if (forward.lastEmitAt && nowMs - forward.lastEmitAt < forward.intervalMs) return;
  forward.lastEmitAt = nowMs;
  emitToolInputForward(ctx, forward);
}

// The interval fold can leave the last fragment unsent. Other tools do not need
// it (their row is replaced by the tool event); a followed file does.
function flushToolInputTail(ctx) {
  const forward = ctx.toolInputForward;
  if (forward && forward.flushTail && forward.pending) emitToolInputForward(ctx, forward);
}

function applyCanonicalBridgeEvent(ctx, event, {
  toolContext,
  handleToolNotification,
  touchProgress,
} = {}) {
  const {
    service, streamId, canonicalBridgeEnabled, transcriptCollector,
    persistCurrentTextSegment, noteDiagnosticToolEvent,
  } = ctx;
  if (!canonicalBridgeEnabled || !event || typeof event !== 'object') {
    return false;
  }
  const eventType = normalizeRuntimeToken(event.type);
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  if (eventType === 'text_delta') {
    if (typeof touchProgress === 'function') touchProgress();
    return applyVisibleTextDelta(ctx, String(payload.delta || ''), {
      sequence: payload.sequence ?? event.seq,
      timestamp: event.ts,
    }, {
      dedupeBySequence: true,
    });
  }
  if (eventType === 'text_part_completed') {
    const completedText = String(payload.text || '');
    if (completedText && !ctx.assistantText) {
      if (typeof touchProgress === 'function') touchProgress();
      return applyVisibleTextDelta(ctx, completedText, {
        sequence: payload.sequence,
        timestamp: event.ts,
      }, {
        dedupeBySequence: false,
        forceAggregateCheckpoint: true,
      });
    }
    if (completedText && completedText.length > ctx.assistantText.length
      && completedText.startsWith(ctx.assistantText)) {
      const suffix = completedText.slice(ctx.assistantText.length);
      if (typeof touchProgress === 'function') touchProgress();
      return applyVisibleTextDelta(ctx, suffix, {
        timestamp: event.ts,
      }, {
        dedupeBySequence: false,
        forceAggregateCheckpoint: true,
      });
    }
    return true;
  }
  if (eventType === 'reasoning_delta') {
    if (typeof touchProgress === 'function') touchProgress();
    const thinkingId = payload.thinking_id || event.part_id;
    if (!isPairedReasoningDelta(ctx, 'canonical', payload.delta, thinkingId)) {
      appendProviderReasoningDelta(ctx, payload.delta, event.ts || new Date().toISOString(), thinkingId, payload);
    }
    return true;
  }
  if (eventType === 'tool_input_delta') {
    if (typeof touchProgress === 'function') touchProgress();
    forwardToolInputDelta(ctx, event, payload);
    return true;
  }
  const toolNotification = canonicalToolNotification(ctx, event);
  if (!toolNotification) {
    return false;
  }
  flushToolInputTail(ctx);
  if (typeof touchProgress === 'function') touchProgress();
  const callId = normalizeRuntimeToken(toolNotification.params?.tool_call_id);
  if (toolNotification.method === 'tool.executing' || toolNotification.method === 'tool.requested') {
    const toolCallAlreadyProjected = toolContext?.seenToolCalls instanceof Set
      && toolContext.seenToolCalls.has(callId);
    if (
      (ctx.canonicalToolStartedCallIds.has(callId) && eventType === 'tool_execution_started')
      || toolCallAlreadyProjected
    ) {
      return true;
    }
    if (toolNotification.method === 'tool.executing') {
      ctx.canonicalToolStartedCallIds.add(callId);
      ctx.unfinishedToolsSettled = false;
    }
    persistCurrentTextSegment({ allowReasoningOnly: true, atToolBoundary: true });
    noteDiagnosticToolEvent({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      phase: toolNotification.method === 'tool.requested' ? 'requested' : 'executing',
    });
    transcriptCollector.noteToolStep({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      status: toolNotification.method === 'tool.requested' ? 'pending' : 'running',
      toolUseMessageId: buildStreamToolUseMessageId(streamId, callId),
    });
  } else if (toolNotification.method === 'tool.result') {
    // W2-2: a backgrounded run_command's result carries its job id — hand it
    // to the tracker (idempotent, so the legacy notification arriving for the
    // same call is harmless).
    noteBackgroundJobFromToolResult(service, ctx, toolNotification.params, toolContext?.workspaceRoot);
    noteDiagnosticToolEvent({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      phase: 'result',
    });
    transcriptCollector.noteToolStep({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      status: toolNotification.params.success === true ? 'completed' : 'error',
      toolUseMessageId: buildStreamToolUseMessageId(streamId, callId),
      toolResultMessageId: buildStreamToolResultMessageId(streamId, callId),
    });
  }
  return typeof handleToolNotification === 'function'
    ? handleToolNotification(service, toolContext, toolNotification, {
      canonicalEvent: true,
      ...(toolNotification.method === 'tool.executing'
        ? { nextAssistantMessageId: `assistant_${ctx.streamId}_seg${ctx.textSegmentIndex}` }
        : {}),
    })
    : false;
}

// The sidecar strips local paths from an Electron-run tool's artifacts
// (electron_tool_bridge.py), and the persisted turn-event normalizer drops an
// artifact without one, so the canonical tool_result journaled
// `generated_artifacts: []` and the image never rendered (GIP-1). Electron
// stashed the paths when it ran the tool; restore them (redacted, trusted)
// before capture, as the legacy tool.result path already does.
function withLocalGeneratedArtifactPaths(ctx, event) {
  const type = normalizeRuntimeToken(event?.type);
  const payload = event?.payload;
  if ((type !== 'tool_execution_completed' && type !== 'tool_execution_failed')
    || !Array.isArray(payload?.generated_artifacts) || !payload.generated_artifacts.length) {
    return event;
  }
  const merged = mergeLocalGeneratedArtifactPaths(ctx.service, {
    streamId: ctx.streamId,
    callId: normalizeRuntimeToken(event.tool_call_id || payload.tool_call_id || payload.toolCallId),
    sessionId: ctx.resolvedSessionId,
    artifacts: payload.generated_artifacts,
  });
  return merged === payload.generated_artifacts
    ? event
    : { ...event, payload: { ...payload, generated_artifacts: merged } };
}

// The `turn.event` branch of handleNotification.
function handleCanonicalTurnEvent(ctx, params, {
  toolContext,
  handleToolNotification,
  touchProgress,
}) {
  const {
    service, streamId, turnMetrics, turnEventCollector, canonicalBridgeEnabled,
    persistCurrentTextSegment,
  } = ctx;
  if (!canonicalBridgeEnabled && service.featureFlags?.canonical_turn_events !== true) return;
  if (ctx.turnLease && params.turn_id !== streamId && params.turn_id !== ctx.turnId) {
    turnMetrics?.recordDroppedCanonicalEvent?.();
    return;
  }
  const identityStampedParams = withIngestedAttachmentRefs(ctx, withLocalGeneratedArtifactPaths(ctx,
    attachWorkspaceIdentityToCanonicalEvent(
      ctx.turnId && params.turn_id === streamId ? { ...params, turn_id: ctx.turnId } : params,
      service,
      toolContext?.workspaceRoot
    )));
  const validation = validateTurnEvent(identityStampedParams);
  if (
    validation.status !== 'accepted'
    && turnMetrics
    && typeof turnMetrics.recordDroppedCanonicalEvent === 'function'
  ) {
    turnMetrics.recordDroppedCanonicalEvent();
  }
  // The pre-tool text enters the turn log before the event that opens its tool row.
  if (validation.status === 'accepted'
    && opensNewToolRow(identityStampedParams, ctx.canonicalToolStartedCallIds, toolContext?.seenToolCalls)) {
    persistCurrentTextSegment({ allowReasoningOnly: true, atToolBoundary: true });
  }
  const captured = turnEventCollector && typeof turnEventCollector.noteEvent === 'function'
    ? turnEventCollector.noteEvent(identityStampedParams, { validation })
    : null;
  if (
    !captured
    && validation.status === 'accepted'
    && reduceToTurnEventKind(validation.event)
    && turnMetrics
    && typeof turnMetrics.recordDroppedCanonicalEvent === 'function'
  ) {
    turnMetrics.recordDroppedCanonicalEvent();
  }
  if (validation.status === 'accepted') {
    applyCanonicalBridgeEvent(ctx, validation.event, {
      toolContext,
      handleToolNotification,
      touchProgress,
    });
  }
}

module.exports = {
  applyVisibleTextDelta,
  handleCanonicalTurnEvent,
};
