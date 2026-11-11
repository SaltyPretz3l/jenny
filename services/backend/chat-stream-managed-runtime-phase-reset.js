// Live-slice lifecycle notifications of the managed-runtime router: phase
// started/completed and chat.stream_reset (which erases all, part or none of
// the answer so far). Split out of chat-stream-managed-runtime-notifications.js
// (still the entry point); handlers receive the same explicit ctx.
const {
  buildPhaseSnapshot,
  normalizeTokenRate,
} = require('./chat-stream-managed-runtime-utils');
const { noteDiscardedDraft } = require('./chat-stream-discarded-drafts');
const {
  normalizePhaseSummary,
} = require('./chat-transcript-phase-collector');

function notePhaseStarted(ctx, params) {
  const { service, transcriptCollector, emitChatStream } = ctx;
  if (service?.featureFlags?.aggregate_checkpoints === true) {
    ctx.aggregateCheckpointPending = true;
  }
  const summary = normalizePhaseSummary(params.summary);
  const tokenRate = normalizeTokenRate(params.tokens_per_second);
  transcriptCollector.notePhaseStarted({
    phase_id: String(params.phase_id || ''),
    phase_kind: String(params.phase_kind || ''),
    iteration: Number(params.iteration || 0) || 0,
    thinking_id: String(params.thinking_id || ''),
    tool_call_id: String(params.tool_call_id || ''),
    tool_name: String(params.tool_name || ''),
    summary,
    ...(tokenRate != null ? { tokens_per_second: tokenRate } : {}),
  });
  ctx.currentPhaseSnapshot = buildPhaseSnapshot({
    phase_id: String(params.phase_id || ''),
    phase_kind: String(params.phase_kind || ''),
    iteration: Number(params.iteration || 0) || 0,
    thinking_id: String(params.thinking_id || ''),
    tool_call_id: String(params.tool_call_id || ''),
    tool_name: String(params.tool_name || ''),
    summary,
  });
  emitChatStream({
    type: 'phase_started',
    phaseId: String(params.phase_id || ''),
    phaseKind: String(params.phase_kind || ''),
    iteration: Number(params.iteration || 0) || 0,
    thinkingId: String(params.thinking_id || ''),
    toolCallId: String(params.tool_call_id || ''),
    toolName: String(params.tool_name || ''),
    summary,
    ...(tokenRate != null ? { tokensPerSecond: tokenRate } : {}),
    ...ctx.eventBase,
  }, { channel: 'phase', phase: ctx.currentPhaseSnapshot });
}

function notePhaseCompleted(ctx, params) {
  const { service, transcriptCollector, emitChatStream } = ctx;
  if (service?.featureFlags?.aggregate_checkpoints === true) {
    ctx.aggregateCheckpointPending = true;
  }
  // Reasoning after a closed reasoning phase (the sidecar ends it at the
  // first tool-call output) can reuse its thinking id; it is a new entry.
  if (String(params.phase_kind || '') === 'reasoning') ctx.reasoningTailBreakPending = true;
  const summary = normalizePhaseSummary(params.summary);
  const tokenRate = normalizeTokenRate(params.tokens_per_second);
  transcriptCollector.notePhaseCompleted({
    phase_id: String(params.phase_id || ''),
    completed_at: new Date().toISOString(),
    summary,
    ...(tokenRate != null ? { tokens_per_second: tokenRate } : {}),
  });
  ctx.currentPhaseSnapshot = buildPhaseSnapshot({
    phase_id: String(params.phase_id || ''),
    phase_kind: String(params.phase_kind || ''),
    iteration: Number(params.iteration || 0) || 0,
    thinking_id: String(params.thinking_id || ''),
    tool_call_id: String(params.tool_call_id || ''),
    tool_name: String(params.tool_name || ''),
    summary,
  }) || ctx.currentPhaseSnapshot;
  emitChatStream({
    type: 'phase_completed',
    phaseId: String(params.phase_id || ''),
    phaseKind: String(params.phase_kind || ''),
    iteration: Number(params.iteration || 0) || 0,
    thinkingId: String(params.thinking_id || ''),
    toolCallId: String(params.tool_call_id || ''),
    toolName: String(params.tool_name || ''),
    summary,
    ...(tokenRate != null ? { tokensPerSecond: tokenRate } : {}),
    ...ctx.eventBase,
  }, { channel: 'phase', phase: ctx.currentPhaseSnapshot });
}

function applyStreamReset(ctx, params) {
  const {
    service, streamId, transcriptCollector, turnEventCollector, assistantBaseMessageId,
    emitChatStream, discardPersistedTextSegmentsForReset,
  } = ctx;
  // Most resets replace the entire active answer. Tool continuations and
  // terminal wind-downs instead preserve earlier durable segments while
  // clearing only the current live slice. This deliberately does not depend
  // on canonicalBridgeEnabled: multi-tool turns need the same persistence
  // behavior with the canonical bridge canary disabled.
  // The Propose nudge has no tool boundary before it, so its prose is saved here and from then on
  // it is an ordinary preserving reset. A real tool_continuation was saved at its boundary.
  const proposeNudge = params.reason === 'propose_nudge';
  if (proposeNudge) ctx.persistCurrentTextSegment?.({ atToolBoundary: true });
  const resetReason = proposeNudge ? 'tool_continuation' : String(params.reason || '');
  const preserveToolContinuation = resetReason === 'tool_continuation';
  // deterministic_replacement is NOT a preserve reason. StreamResetEvent's
  // contract (sidecar/ai/routing/loop_events.py) names it alongside
  // provider_retry / nudge_retry / reflexive_retry / post_tool_restart as a
  // garbage reset whose "discarded text is bad and must not survive", and
  // its emission site
  // (tool_loop_finalize.py) fires it when the model produced pseudo-search
  // text for a lookup it could not run — the loop then returns the real
  // unavailability answer instead. Preserving those segments persists
  // fabricated content into the transcript.
  const preservePriorSegments = preserveToolContinuation
    || resetReason === 'model_winddown';
  // What this reset erases (see the stream_reset emit below); decided before
  // anything is cleared so the discarded-drafts receipt sees the real state.
  const discardScope = !preservePriorSegments
    ? 'all'
    : (preserveToolContinuation ? 'none' : 'live_slice');
  // Receipt count: only a reset that erased visible content (text or
  // reasoning of the live slice; for 'all' also earlier segments) counts.
  // ctx.reasoningEntries spans the whole turn; the collector's slice phases
  // hold only the unsaved live slice's reasoning.
  const liveSliceErased = Boolean(String(ctx.currentSegmentText || '').trim())
    || (transcriptCollector.slice?.phases || []).some((phase) => (
      phase?.phase_kind === 'reasoning' && phase.entries?.length > 0
    ));
  if (
    (discardScope === 'live_slice' && liveSliceErased)
    || (discardScope === 'all' && (
      liveSliceErased
      || ctx.persistedTextSegmentIds?.length > 0
      || ctx.refusedTextSegments?.length > 0
    ))
  ) {
    ctx.discardedDrafts = noteDiscardedDraft(ctx.discardedDrafts, resetReason);
  }
  if (!preservePriorSegments) {
    discardPersistedTextSegmentsForReset();
    // The reset discards the persisted segment messages, so the live-captured
    // text/reasoning turn events that referenced them must not persist either.
    if (turnEventCollector && typeof turnEventCollector.discardCapturedEvents === 'function') {
      turnEventCollector.discardCapturedEvents(streamId, [
        'assistant_text_segment',
        'reasoning_phase',
      ]);
    }
  } else if (
    !preserveToolContinuation
    && turnEventCollector
    && typeof turnEventCollector.discardCapturedEvents === 'function'
  ) {
    turnEventCollector.discardCapturedEvents(
      streamId,
      ['assistant_text_segment', 'reasoning_phase'],
      { primaryMessageId: assistantBaseMessageId },
    );
  }
  ctx.lastReasoningEventPhaseKey = '';
  // Advance the reasoning ordinal even when preserving: the pre-reset phase's
  // event_id is already in the journal (which dedupes by event_id), so a
  // post-reset reasoning phase needs a fresh id to journal at all — otherwise
  // it silently collides with the pre-reset phase and one is dropped.
  ctx.reasoningTurnEventOrdinal += 1;
  ctx.assistantText = '';
  ctx.currentSegmentText = '';
  ctx.reasoningEntries = [];
  ctx.reasoningTailBreakPending = false;
  ctx.reasoningRawTailText = '';
  ctx.reasoningSanitizedTailText = '';
  ctx.reasoningTruncationLogged = false;
  ctx.questionBatch = null;
  ctx.thinkingStatusText = '';
  ctx.currentThinkingPhaseId = '';
  ctx.lastReasoningThinkingId = '';
  ctx.reasoningTransportChunks = null;
  ctx.streamSawText = false;
  ctx.streamSawDone = false;
  ctx.streamSawBatch = false;
  // Convention-following only, with no reachable repro today: a successful
  // chat.done both sets this and finalizes in the same block, so a reset can
  // never land between the two. Kept because this block's job is to void every
  // terminal-shaped field the discarded attempt produced, and a future change
  // that defers finalization would otherwise reintroduce the stale carry.
  ctx.resumableStop = null;
  ctx.completion = null;
  // Keep hasPersistedSegments on the preserve path: the preserved segments are
  // still real, so finalize must route the final answer through the proven
  // multi-segment path (persist it as its own segment) rather than rewriting
  // the base message. On the discard path nothing survives, so clear it.
  // The refusal latch clears with it: a refusal describes content this
  // discard just erased, and left set it would falsely veto the restarted
  // reply's settle (spurious durability warning + retained active_turn).
  // On the preserve path a pre-reset refusal is still a real durable loss,
  // so the latch survives there.
  if (!preservePriorSegments) {
    ctx.hasPersistedSegments = false;
    ctx.segmentPersistRefused = false;
    ctx.refusedTextSegments = [];
  }
  ctx.visibleAssistantMessageId = assistantBaseMessageId;
  ctx.currentPhaseSnapshot = null;
  ctx.appliedTextSequenceGate.reset();
  ctx.canonicalToolStartedCallIds.clear();
  ctx.legacyTextSequence = 0;
  if (service?.featureFlags?.aggregate_checkpoints === true) {
    ctx.aggregateCheckpointPending = true;
  }
  transcriptCollector.resetSlice();
  transcriptCollector.turnHasVisibleText = false;
  // Emit the exact next persisted assistant segment ID after reset because the
  // renderer's local counter can diverge; compute it after reset bookkeeping.
  const nextAssistantMessageId = `assistant_${streamId}_seg${ctx.textSegmentIndex}`;
  // What this reset ERASED, named for the renderer so it never has to
  // re-derive the branch above from `reason` alone (it cannot:
  // model_winddown erases the live slice while keeping its persisted
  // segments, and transcripts recorded before the post-1.2.0 flag collapse
  // carry 'all' for tool_continuation). Exactly three shapes:
  //   'all'        -> discardPersistedTextSegmentsForReset() + every captured
  //                   assistant_text_segment / reasoning_phase for the turn.
  //   'live_slice' -> persisted segments survive; only the captured events
  //                   scoped to assistantBaseMessageId (the unsaved live
  //                   slice) are dropped. model_winddown.
  //   'none'       -> nothing erased. tool_continuation.
  emitChatStream({
    type: 'stream_reset',
    // The renderer folds a discarding reset's erased rows into one "Draft
    // discarded" line; a preserved tool_continuation reset is genuine
    // commentary and must not fold. Forward the sidecar's reason so the live
    // reducer can tell the two apart and name it.
    reason: resetReason,
    next_assistant_message_id: nextAssistantMessageId,
    preserve_prior_segments: preservePriorSegments,
    discard_scope: discardScope,
    ...ctx.eventBase,
  }, { channel: 'control', phase: null });
}

module.exports = {
  applyStreamReset,
  notePhaseCompleted,
  notePhaseStarted,
};
