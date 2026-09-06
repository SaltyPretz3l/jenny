// Persists and resets managed-stream segments through the shared runtime ctx.

function persistCurrentTextSegment(ctx, options) {
  const allowReasoningOnly = Boolean(options && options.allowReasoningOnly);
  // Tool-boundary persists (commentary/intermediate narration) carry an
  // explicit `commentary` phase; the finalize persist (final answer) does not,
  // so the renderer's positional pass still marks it final_answer.
  const atToolBoundary = Boolean(options && options.atToolBoundary);
  // Every persist attempt marks a slice boundary for reasoning entries, even
  // when nothing is collected yet: the next reasoning delta must start a new
  // entry rather than coalesce into one a persisted segment carries.
  ctx.reasoningTailBreakPending = true;
  ctx.reasoningRawTailText = '';
  const hasSegmentText = Boolean(ctx.currentSegmentText.trim());
  if (!hasSegmentText && !allowReasoningOnly) {
    return;
  }
  const { streamId, transcriptCollector, adapter, service, turnEventCollector } = ctx;
  const segmentId = `assistant_${streamId}_seg${ctx.textSegmentIndex}`;
  const segmentTimestamp = new Date().toISOString();
  transcriptCollector.completeCurrentPhase({}, segmentTimestamp);
  const fallbackReasoningEntries = ctx.persistedTextSegmentIds.length === 0
    ? ctx.reasoningEntries
    : [];
  const transcriptFields = transcriptCollector.buildAssistantMessageFields({
    fallbackReasoningEntries,
  });
  if (!hasSegmentText) {
    // Tool boundary with no visible pre-tool text: persist the collected
    // reasoning as its own content-less assistant segment so the pre-tool
    // thinking stays attached to a message that PRECEDES the tool_use
    // message. Without this, the slice survives the boundary and the
    // gen-0 reasoning lands on the FINAL assistant message, which the
    // timeline projector then orders AFTER the tool rows. A boundary with
    // nothing collected stays a no-op.
    const reasoningEntriesCollected = transcriptFields
      && transcriptFields.reasoning
      && Array.isArray(transcriptFields.reasoning.entries)
      ? transcriptFields.reasoning.entries
      : [];
    if (!reasoningEntriesCollected.length) {
      return;
    }
  }
  const segmentMessage = {
    id: segmentId,
    role: 'assistant',
    content: hasSegmentText ? ctx.currentSegmentText : '',
    timestamp: segmentTimestamp,
    finalizedAt: segmentTimestamp,
    client_message_id: segmentId,
    model_used: ctx.model,
    // Finalize-only: the fallback settle path routes a segmented turn's FINAL
    // slice through here instead of buildAssistantCompletionTerminalMutation,
    // so the resumable-stop detail has to ride along or the durable message
    // loses it while the live `complete` event still carries it.
    ...(options && options.resumableStop ? { resumable_stop: options.resumableStop } : {}),
    ...transcriptFields,
  };
  // Once a production coordinator sees the first refused boundary segment,
  // keep every later segment in the same missing suffix. The terminal commit
  // can then append that suffix atomically and in order; allowing a later
  // boundary write to leapfrog the missing row makes retry ordering impossible.
  const deferredAfterRefusal = ctx.segmentPersistRefused === true
    && typeof service?.terminalCoordinator?.settle === 'function';
  const persistedSegmentSummary = deferredAfterRefusal
    ? null
    : adapter.appendMessage(segmentMessage, { model: ctx.model, updatePreview: false });
  if (!persistedSegmentSummary) {
    // CTL-002: the store refused the segment. The stream keeps running (the
    // live text already painted) but the refusal is tracked so the turn's
    // settle emits the bounded durability warning. The segment bookkeeping
    // below still runs — event retargeting and slice resets keep the LIVE
    // stream coherent regardless of durability.
    ctx.segmentPersistRefused = true;
    if (!Array.isArray(ctx.refusedTextSegments)) ctx.refusedTextSegments = [];
    ctx.refusedTextSegments.push(segmentMessage);
    if (!deferredAfterRefusal && typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'chat.assistant_segment_persist_refused', {
        sessionId: ctx.resolvedSessionId,
        streamId,
        segmentId,
      });
    }
  }
  // Record the durable turn events for this segment now that the message id
  // is real: one assistant_text_segment event per text-bearing persisted
  // segment (with the per-turn segment index), and the slice's reasoning
  // events retargeted from the synthetic base assistant id onto the segment
  // message that actually carries those phases. Audit A3: both are gated on
  // the append being ACCEPTED — a refused segment has no message, and durable
  // events pointing at a never-persisted id corrupt the reload projection.
  if (persistedSegmentSummary && hasSegmentText) {
    const visibleSegmentsForEvent = Array.isArray(transcriptFields.visible_segments)
      ? transcriptFields.visible_segments
      : [];
    const lastVisibleSegment = visibleSegmentsForEvent[visibleSegmentsForEvent.length - 1] || {};
    // The first persisted tool-boundary slice is pre-first-tool commentary;
    // any later boundary slice is intermediate. Gated by the shared display
    // flag so flag-off behaviour is byte-identical to today (the stamp would
    // otherwise survive a cancelled turn that never hits a discarding reset).
    const responseLoopDisplayV2 = service?.featureFlags?.response_loop_display_v2 === true;
    const assistantPhase = responseLoopDisplayV2 && atToolBoundary
      ? (ctx.textSegmentIndex === 0 ? 'commentary' : 'intermediate')
      : '';
    ctx.noteTurnEvent('assistant_text_segment', {
      event_id: `${streamId}:assistant_text_segment:live:${ctx.textSegmentIndex}`,
      primary_message_id: segmentId,
      source_message_ids: [segmentId],
      status: 'completed',
      phase_id: String(lastVisibleSegment.phase_id || ''),
      segment_group_index: ctx.textSegmentIndex,
      started_at: segmentTimestamp,
      completed_at: segmentTimestamp,
      payload: {
        segment_id: String(lastVisibleSegment.segment_id || `segment_${streamId}_${ctx.textSegmentIndex}`),
        phase_id: String(lastVisibleSegment.phase_id || ''),
        text: ctx.currentSegmentText,
        segment_index: ctx.textSegmentIndex,
        ...(assistantPhase ? { assistant_phase: assistantPhase } : {}),
      },
    });
  }
  const reasoningPhaseIds = (Array.isArray(transcriptFields.phases) ? transcriptFields.phases : [])
    .filter((phase) => String(phase?.phase_kind || '') === 'reasoning')
    .map((phase) => String(phase?.phase_id || ''))
    .filter(Boolean);
  if (
    persistedSegmentSummary
    && reasoningPhaseIds.length
    && turnEventCollector
    && typeof turnEventCollector.retargetCapturedEvents === 'function'
  ) {
    turnEventCollector.retargetCapturedEvents(streamId, {
      phaseIds: reasoningPhaseIds,
      messageId: segmentId,
    });
  }
  if (reasoningPhaseIds.length) {
    // The slice's reasoning phases are sealed to this segment. A later slice
    // may legally REUSE their phase ids (sidecar iteration numbering restarts
    // when a tool loop resumes after an approval), so the live event key must
    // not treat a reused id as the same phase — mirror the stream_reset
    // handler: a fresh ordinal keeps the next phase's event_id unique for the
    // event_id-deduping journal.
    ctx.lastReasoningEventPhaseKey = '';
    ctx.reasoningTurnEventOrdinal += 1;
  }
  // Audit A3: durable bookkeeping only for ACCEPTED segments. A refused
  // segment has no row — recording it as persisted (or pointing the visible
  // id at it) would make later reconciliation and the durability warning
  // reference a message that does not exist. The refused slice's text/index
  // resets below still run so the LIVE stream stays coherent; leaving
  // hasPersistedSegments false for a refused-only turn also lets the final
  // settle retry the whole reply through the full-append path.
  if (persistedSegmentSummary) {
    ctx.persistedTextSegmentIds.push(segmentId);
    ctx.hasPersistedSegments = true;
    if (hasSegmentText) {
      ctx.visibleAssistantMessageId = segmentId;
    }
  }
  transcriptCollector.resetSlice();
  ctx.textSegmentIndex += 1;
  ctx.currentSegmentText = '';
  // Durability contract: null = the store refused this segment; a truthy
  // summary = accepted. (The early no-op returns above stay undefined.)
  return persistedSegmentSummary || null;
}

function discardPersistedTextSegmentsForReset(ctx) {
  if (!ctx.persistedTextSegmentIds.length) {
    return;
  }
  const { service, resolvedSessionId, streamId } = ctx;
  const staleIds = new Set(ctx.persistedTextSegmentIds);
  const store = service.sessionStore || null;
  let staleSegmentsRemoved = false;
  if (
    store
    && typeof store.getSessionMessages === 'function'
    && typeof store.replaceMessages === 'function'
  ) {
    const currentMessages = store.getSessionMessages(resolvedSessionId);
    if (Array.isArray(currentMessages)) {
      const filteredMessages = currentMessages.filter((message) =>
        !staleIds.has(String(message?.id || '').trim())
      );
      store.replaceMessages(resolvedSessionId, filteredMessages);
      staleSegmentsRemoved = true;
    } else if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'chat.stream_reset_messages_unavailable', {
        sessionId: resolvedSessionId,
        streamId,
        staleSegmentCount: staleIds.size,
      });
    }
  }
  if (!staleSegmentsRemoved && store && typeof store.updateMessage === 'function') {
    for (const messageId of staleIds) {
      store.updateMessage(resolvedSessionId, messageId, {
        content: '',
        phases: [],
        visible_segments: [],
        tool_steps: [],
        reasoning: { source: 'none', entries: [] },
      });
    }
  }
  ctx.persistedTextSegmentIds = [];
}

module.exports = {
  persistCurrentTextSegment,
  discardPersistedTextSegmentsForReset,
};
