(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineRenderLadder = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createRenderLadder(context) {
    const {
      state,
      uiRuntime,
      appendClientLog,
      timelineVisibilityTracker,
      recordTurnArticleRolloutSignal,
      describeDomWrite,
      describeStreamRevealPatchBlock,
      forceFullRender,
      projectionRevisionChanged,
      recapExpansionChanged,
      threadExpansionChanged,
      messages,
      latestAssistantMessageId,
      structureSignature,
      derived,
      renderReason,
    } = context;

    // Post-approval flicker RCA: every full render is charged to the FIRST
    // gate that was true, in the same order the ladder below tests them, so
    // the per-turn diagnostics say WHY the fast paths were skipped.
    function resolveFullRenderReason(fallbackReason) {
      if (forceFullRender) {
        return 'force';
      }
      if (projectionRevisionChanged) {
        return 'projection_revision';
      }
      if (recapExpansionChanged) {
        return 'recap_expansion';
      }
      if (threadExpansionChanged) {
        return 'thread_expansion';
      }
      const patchBlock = String(describeStreamRevealPatchBlock({
        currentSessionId: state.currentSessionId,
        messages,
        latestAssistantMessageId,
        structureSignature,
        streamingMessage: derived.streamingMessage,
      }) || '');
      // `no_streaming_message` is describePatchBlock's FIRST guard -- it
      // returns before consulting the timeline, session, signature or marker,
      // so it means only "nothing is live", never "the patch path failed".
      // Charging it to cannot_patch:* made benign frames read as blocked fast
      // paths and cost the 2026-08-26 flicker read a whole pass. Name why the
      // tail is not live instead, so the next read is an answer.
      if (patchBlock === 'no_streaming_message') {
        return 'no_live_stream:' + describeMissingStreamTail(messages);
      }
      if (patchBlock) {
        return 'cannot_patch:' + patchBlock;
      }
      return fallbackReason || 'unclassified';
    }

    // Bounded on purpose: fullRenderReasons is a histogram keyed by this
    // string, so it must never absorb ids, content, or anything that grows
    // with the transcript. Four buckets, and they are not interchangeable --
    // `tail_not_eligible` means a message IS streaming and the derived state
    // refused it, which is a row-identity bug wearing a benign disguise.
    function describeMissingStreamTail(list) {
      const tail = Array.isArray(list) ? list : [];
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        const message = tail[i];
        if (!message || String(message.role || '') !== 'assistant') {
          continue;
        }
        const status = String(message.status || '');
        if (status === 'streaming') {
          return 'tail_not_eligible';
        }
        return status === 'error' ? 'tail_error' : 'tail_settled';
      }
      return 'no_assistant';
    }
    const catchupState = renderReason === 'view_catchup'
      ? (timelineVisibilityTracker?.consumeHiddenCatchup?.(state.currentSessionId) || { required: false })
      : { required: false };
    const catchupActive = catchupState.required === true;
    let catchupRenderCommitted = false;

    function markCatchupPatched(mode, extra = {}) {
      if (!catchupActive || catchupRenderCommitted) {
        return;
      }
      catchupRenderCommitted = true;
      appendClientLog('INFO', 'timeline.catchup_patched', {
        sessionId: state.currentSessionId,
        streamId: catchupState.streamId || String(derived.streamingMessage?.streamId || ''),
        mode,
        hiddenRenderableEventCount: catchupState.hiddenRenderableEventCount || 0,
        ...extra,
      });
      timelineVisibilityTracker?.markRenderCommitted?.(state.currentSessionId, { patched: true });
    }

    function markCatchupFullRenderFallback(reason, extra = {}) {
      if (!catchupActive || catchupRenderCommitted) {
        return;
      }
      catchupRenderCommitted = true;
      appendClientLog(
        reason === 'final_full_render' ? 'INFO' : 'WARN',
        'timeline.catchup_full_render_fallback',
        {
          sessionId: state.currentSessionId,
          streamId: catchupState.streamId || String(derived.streamingMessage?.streamId || ''),
          reason,
          hiddenRenderableEventCount: catchupState.hiddenRenderableEventCount || 0,
          ...extra,
        }
      );
      timelineVisibilityTracker?.markRenderCommitted?.(state.currentSessionId, { patched: false });
    }

    function nextStreamingArticleRebuildSeq(turnId) {
      const normalizedTurnId = String(turnId || '').trim();
      const counter = uiRuntime.streamingArticleRebuildCounter
        && typeof uiRuntime.streamingArticleRebuildCounter === 'object'
        ? uiRuntime.streamingArticleRebuildCounter
        : { turnId: '', n: 0 };
      if (counter.turnId !== normalizedTurnId) {
        counter.turnId = normalizedTurnId;
        counter.n = 0;
      }
      counter.n += 1;
      uiRuntime.streamingArticleRebuildCounter = counter;
      return counter.n;
    }

    function recordStreamingArticleRebuild(details) {
      if (state?.features?.featureFlags?.chat_timeline_render_telemetry !== true) {
        return;
      }
      const stats = details?.stats || null;
      recordTurnArticleRolloutSignal('streaming_article_rebuild', {
        turnId: details.turnId,
        streamingMessageId: details.streamingMessageId,
        structureSignature,
        rebuildSeq: nextStreamingArticleRebuildSeq(details.turnId),
        outcome: details.outcome,
        ...(stats ? {
          reused: stats.reused,
          cloned: stats.cloned,
          removed: stats.removed,
        } : {}),
      });
      // Guarded the same way this pipeline guards every other borrowed
      // stream-dom-patch function: the module resolvers fall back to `{}`, so
      // an unresolved sibling would make a DIAGNOSTIC throw inside the render
      // path. Telemetry must never be able to break a paint.
      if (typeof describeDomWrite === 'function') {
        recordTurnArticleRolloutSignal(
          'timeline_dom_write',
          describeDomWrite('streaming_article', details.outcome, details.stats)
        );
      }
    }

    return {
      catchupActive,
      resolveFullRenderReason,
      markCatchupPatched,
      markCatchupFullRenderFallback,
      recordStreamingArticleRebuild,
    };
  }

  return { createRenderLadder };
});
