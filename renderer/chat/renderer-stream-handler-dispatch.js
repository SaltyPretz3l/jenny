/* renderer/chat/renderer-stream-handler-dispatch.js -- per-payload dispatch router + buffered-event flush/drop helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerDispatch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createStreamDispatchRouter(options = {}) {
    const {
      state,
      normalizeId,
      normalizeString,
      appendClientLog,
      markStartupAudit,
      resolvePayloadSessionId,
      shouldBufferStreamEvent,
      bufferStreamEvent,
      consumeBufferedStreamDegradation,
      notePreflightEvent,
      flushPendingStreamCommit,
      handlePresenceStreamEvent,
      handleWorkspaceActivityStreamEvent,
      handlers,
      isRenderableBufferedStreamEvent,
      waitForRenderFrame,
      flushRenderableBatchSize,
      onStartupFirstEvent,
      onBufferedStreamFlushed,
      isStreamFinalized,
      isStreamTerminalSettled,
      markStreamTerminalSettled,
      getStreamTerminalCommitState,
      beginStreamTerminalCommit,
      finishStreamTerminalCommit,
      isStreamCurrentForSession,
    } = options || {};

    if (!state || typeof state !== 'object') {
      throw new Error('createStreamDispatchRouter requires options.state');
    }
    if (typeof normalizeId !== 'function' || typeof normalizeString !== 'function') {
      throw new Error('createStreamDispatchRouter requires normalizeId and normalizeString');
    }
    if (typeof appendClientLog !== 'function') {
      throw new Error('createStreamDispatchRouter requires appendClientLog');
    }
    if (!handlers || typeof handlers !== 'object') {
      throw new Error('createStreamDispatchRouter requires options.handlers');
    }
    if (typeof isRenderableBufferedStreamEvent !== 'function' || typeof waitForRenderFrame !== 'function') {
      throw new Error('createStreamDispatchRouter requires isRenderableBufferedStreamEvent and waitForRenderFrame');
    }

    const FLUSH_BATCH_SIZE = Number(flushRenderableBatchSize) > 0 ? Number(flushRenderableBatchSize) : 5;
    const safeMarkStartupAudit = typeof markStartupAudit === 'function' ? markStartupAudit : () => {};
    const safeNotifyStartupOnce = typeof onStartupFirstEvent === 'function' ? onStartupFirstEvent : () => true;
    const safeHandlePresence = typeof handlePresenceStreamEvent === 'function' ? handlePresenceStreamEvent : () => {};
    // File Map Living Atlas seam (W3): mirrors the presence pattern above —
    // same injected-callback shape, resolved defensively so an un-wired
    // caller behaves byte-identically to today.
    const safeHandleActivity = typeof handleWorkspaceActivityStreamEvent === 'function'
      ? handleWorkspaceActivityStreamEvent
      : () => {};
    const safeFlushPendingCommit = typeof flushPendingStreamCommit === 'function' ? flushPendingStreamCommit : () => {};
    const safeNotePreflight = typeof notePreflightEvent === 'function' ? notePreflightEvent : () => {};
    const safeBufferStreamEvent = typeof bufferStreamEvent === 'function' ? bufferStreamEvent : () => {};
    const safeConsumeBufferDegradation = typeof consumeBufferedStreamDegradation === 'function'
      ? consumeBufferedStreamDegradation
      : () => null;
    const safeShouldBuffer = typeof shouldBufferStreamEvent === 'function' ? shouldBufferStreamEvent : () => false;
    const safeResolveSessionId = typeof resolvePayloadSessionId === 'function' ? resolvePayloadSessionId : (p) => p?.sessionId;
    const safeIsStreamFinalized = typeof isStreamFinalized === 'function' ? isStreamFinalized : () => false;
    // Fallback treats every finalized stream as settled — i.e. the strict
    // absorb-everything behavior — so an un-wired caller loses only the
    // late-terminal reconciliation allowance, never the CTL-003 guarantee.
    const safeIsStreamTerminalSettled = typeof isStreamTerminalSettled === 'function'
      ? isStreamTerminalSettled
      : (streamId) => safeIsStreamFinalized(streamId);
    const safeMarkStreamTerminalSettled = typeof markStreamTerminalSettled === 'function'
      ? markStreamTerminalSettled
      : () => {};
    const safeGetStreamTerminalCommitState = typeof getStreamTerminalCommitState === 'function'
      ? getStreamTerminalCommitState
      : (streamId) => (safeIsStreamTerminalSettled(streamId) ? 'committed' : '');
    const safeBeginStreamTerminalCommit = typeof beginStreamTerminalCommit === 'function'
      ? beginStreamTerminalCommit
      : (streamId) => {
          if (safeIsStreamTerminalSettled(streamId)) return { accepted: false, state: 'committed' };
          safeMarkStreamTerminalSettled(streamId);
          return { accepted: true, state: 'received' };
        };
    const safeFinishStreamTerminalCommit = typeof finishStreamTerminalCommit === 'function'
      ? finishStreamTerminalCommit
      : () => {};
    const safeIsStreamCurrentForSession = typeof isStreamCurrentForSession === 'function'
      ? isStreamCurrentForSession
      : () => true;
    const flushingStreamIds = new Set();
    // Per-stream paint diagnostics (client_timing); module load order makes
    // this best-effort by design.
    const streamClientMetrics = (typeof globalThis !== 'undefined'
      && globalThis.rendererStreamClientMetricsModule
      && typeof globalThis.rendererStreamClientMetricsModule.getShared === 'function')
      ? globalThis.rendererStreamClientMetricsModule.getShared()
      : null;

    function normalizePayloadType(value) {
      const normalizedType = normalizeString(value);
      if (normalizedType === 'done' || normalizedType === 'finish') {
        return 'complete';
      }
      return value;
    }

    function normalizeBufferedTerminalPayload(payload) {
      if (!payload || typeof payload !== 'object') return null;
      if (normalizeString(payload.type).toLowerCase() !== 'cancelled') return payload;
      return { ...payload, type: 'error', status: normalizeString(payload.status) || 'cancelled' };
    }

    const TYPES_THAT_FLUSH_PENDING = new Set([
      'phase_started',
      'phase_completed',
      'tool_use',
      'tool_approval_needed',
      'user_questions_requested',
      'tool_result',
      'question_batch',
      'message_updated',
      'complete',
      'error',
    ]);

    // Terminal is an absorbing state (CTL-003): once a stream finalized, every
    // late/duplicate event for it is rejected HERE, before pending-commit
    // flushing or any handler mutation — handlers touch lifecycle, indicator,
    // and reducer state ahead of their own finalized checks, so a per-handler
    // guard cannot hold the boundary. `message_updated` passes through: it is
    // the settled-message reconciliation channel (background monitor metadata,
    // same-status settled updates) and legitimately arrives post-terminal.
    const POST_TERMINAL_PASSTHROUGH_TYPES = new Set(['message_updated']);

    // A stop/preempt finalizes a stream via clearStream WITHOUT any terminal
    // handler running, leaving its partial bubble status 'streaming' at its
    // turn position. The provider's genuine terminal for that stream — the
    // late error behind the "reply rendered above its prompt" live incident —
    // must still settle that bubble, so terminal types pass the finalized
    // gate until the FIRST terminal has actually been dispatched
    // (isStreamTerminalSettled). Every CTL-003 absorb case reaches terminal
    // through a real complete/error, so it is settled by the time a late
    // duplicate arrives and still absorbs.
    const LATE_TERMINAL_RECONCILE_TYPES = new Set(['complete', 'error']);
    const TERMINAL_PAYLOAD_TYPES = new Set(['complete', 'error', 'question_batch']);

    async function handleStreamPayload(rawPayload, callOptions = {}) {
      const payload = {
        ...rawPayload,
        type: normalizePayloadType(rawPayload?.type),
        sessionId: safeResolveSessionId(rawPayload),
      };
      if (safeNotifyStartupOnce()) {
        safeMarkStartupAudit('first-stream-event', {
          type: normalizeString(payload.type),
          streamId: normalizeId(payload.streamId),
          sessionId: normalizeId(payload.sessionId),
        });
      }
      function notifyPresence(nextPayload = payload) {
        try {
          safeHandlePresence(nextPayload);
        } catch (error) {
          appendClientLog('WARN', 'stream.presence_event_failed', {
            type: String(nextPayload?.type || payload?.type || '').slice(0, 60),
            streamId: String(nextPayload?.streamId || payload?.streamId || '').slice(0, 30),
            sessionId: String(nextPayload?.sessionId || payload?.sessionId || '').slice(0, 30),
            message: String(error?.message || error).slice(0, 200),
          });
        }
      }
      // Per-call try/catch isolation mirrors notifyPresence exactly, so a
      // throwing activity-bus ingest can never break stream dispatch.
      function notifyActivity(nextPayload = payload) {
        try {
          safeHandleActivity(nextPayload);
        } catch (error) {
          appendClientLog('WARN', 'stream.activity_event_failed', {
            type: String(nextPayload?.type || payload?.type || '').slice(0, 60),
            streamId: String(nextPayload?.streamId || payload?.streamId || '').slice(0, 30),
            sessionId: String(nextPayload?.sessionId || payload?.sessionId || '').slice(0, 30),
            message: String(error?.message || error).slice(0, 200),
          });
        }
      }
      const payloadStreamId = normalizeId(payload.streamId);
      if (payload.type === 'buffer_degraded') {
        return handlers.handleBufferDegraded(payload, callOptions);
      }
      // The gate consults BOTH registries: `finalized` (clearStream ran —
      // stop/preempt or terminal cleanup) and `settled` (a terminal event was
      // actually routed to its handler). A terminal handler can throw BEFORE
      // it reaches finalizeTerminalStream, leaving the stream settled but
      // never finalized — such a stream is just as dead, and a duplicate
      // terminal must not re-run the handler. The one-shot preempt allowance
      // stays: finalized with NO terminal ever dispatched lets the first
      // genuine late complete/error through.
      if (payloadStreamId) {
        const finalized = safeIsStreamFinalized(payloadStreamId);
        const settled = safeIsStreamTerminalSettled(payloadStreamId);
        const terminalCommitState = safeGetStreamTerminalCommitState(payloadStreamId, payload.sessionId);
        const committed = terminalCommitState === 'committed';
        const terminalInProgress = terminalCommitState === 'committing';
        const isTerminalType = TERMINAL_PAYLOAD_TYPES.has(payload.type);
        const allowLateTerminalReconcile = isTerminalType && !committed && !terminalInProgress
          && (terminalCommitState === 'failed_repairable'
            || (finalized && !settled && LATE_TERMINAL_RECONCILE_TYPES.has(payload.type)));
        const pendingStreamKnown = state.pendingStreams?.has?.(payloadStreamId) === true;
        const historicalMessages = state.messagesBySession?.get?.(normalizeId(payload.sessionId));
        const historicalStreamKnown = Array.isArray(historicalMessages) && historicalMessages.some((message) => (
          normalizeId(message?.streamId || message?.parentStreamId) === payloadStreamId
          || normalizeId(message?.tool_call?.parent_stream_id || message?.tool_result?.parent_stream_id) === payloadStreamId
        ));
        // A different current generation is stale only when renderer evidence
        // proves this stream previously existed and is no longer pending. This
        // preserves legacy concurrent-stream projection while fencing an old
        // stream after bounded tombstone eviction.
        const staleGeneration = !safeIsStreamCurrentForSession(payload.sessionId, payloadStreamId)
          && !pendingStreamKnown
          && historicalStreamKnown;
        const allowStaleTerminalRepair = staleGeneration && isTerminalType
          && LATE_TERMINAL_RECONCILE_TYPES.has(payload.type) && !committed && !terminalInProgress;
        if ((finalized || settled || terminalCommitState || staleGeneration)
          && !POST_TERMINAL_PASSTHROUGH_TYPES.has(payload.type)
          && !allowLateTerminalReconcile
          && !allowStaleTerminalRepair) {
          appendClientLog('INFO', 'stream.late_event_dropped_terminal', {
            type: String(payload.type || '').slice(0, 60),
            streamId: String(payload.streamId || '').slice(0, 30),
            sessionId: String(payload.sessionId || '').slice(0, 30),
          });
          return { buffered: false, terminal: true, droppedLate: true };
        }
      }
      // W2-1: live tool-output chunks are EPHEMERAL — never buffer them for
      // replay. When the pipeline would buffer, drop the chunk instead; the
      // paired tool_result carries the authoritative output.
      // Ephemeral live-only payloads: a replayed one is worse than none. The
      // tool_output_chunk tail is superseded by its tool_result; a context
      // usage snapshot is superseded by the next snapshot (and by the turn's
      // terminal usage), so a buffered one would only repaint a stale ring.
      const isEphemeralOutputChunk = payload.type === 'tool_output_chunk'
        || payload.type === 'context_usage';
      if (callOptions.allowBuffer !== false && payloadStreamId && flushingStreamIds.has(payloadStreamId)) {
        if (isEphemeralOutputChunk) {
          return { buffered: false, terminal: false };
        }
        appendClientLog('DEBUG', 'stream.event_buffered_during_flush', {
          type: payload.type,
          streamId: String(payload.streamId || '').slice(0, 30),
          sessionId: String(payload.sessionId || '').slice(0, 30),
        });
        safeNotePreflight(payload, payload.type || 'unknown');
        safeBufferStreamEvent(payload);
        return { buffered: true, terminal: false };
      }
      if (callOptions.allowBuffer !== false && safeShouldBuffer(payload)) {
        if (isEphemeralOutputChunk) {
          return { buffered: false, terminal: false };
        }
        appendClientLog('DEBUG', 'stream.event_buffered', {
          type: payload.type,
          streamId: String(payload.streamId || '').slice(0, 30),
          sessionId: String(payload.sessionId || '').slice(0, 30),
        });
        safeNotePreflight(payload, payload.type || 'unknown');
        safeBufferStreamEvent(payload);
        return { buffered: true, terminal: false };
      }
      if (!payload.sessionId && payload.type !== 'started') {
        appendClientLog('WARN', 'stream.no_session_id', {
          type: payload.type,
          streamId: String(payload.streamId || '').slice(0, 30),
        });
        return { buffered: false, terminal: false };
      }
      if (TYPES_THAT_FLUSH_PENDING.has(payload.type)) {
        safeFlushPendingCommit(payload.streamId);
      }
      const isTerminalPayload = payloadStreamId && TERMINAL_PAYLOAD_TYPES.has(payload.type);
      if (isTerminalPayload) {
        const beginResult = safeBeginStreamTerminalCommit(payloadStreamId, payload.sessionId);
        if (beginResult?.accepted !== true) {
          appendClientLog('INFO', 'stream.late_event_dropped_terminal', {
            type: String(payload.type || '').slice(0, 60),
            streamId: String(payload.streamId || '').slice(0, 30),
            sessionId: String(payload.sessionId || '').slice(0, 30),
            terminalState: String(beginResult?.state || '').slice(0, 30),
          });
          return { buffered: false, terminal: true, droppedLate: true };
        }
      }
      try {
        if (payload.type === 'started') return await handlers.handleStarted(payload);
        if (payload.type === 'thinking_status') return await handlers.handleThinkingStatus(payload);
        if (payload.type === 'phase_started') {
          const result = await handlers.handlePhaseStarted(payload);
          notifyPresence(payload);
          return result;
        }
        if (payload.type === 'phase_completed') return await handlers.handlePhaseCompleted(payload);
        if (payload.type === 'agent_status') return await handlers.handleAgentStatus(payload);
        if (payload.type === 'tool_use') {
          const result = await handlers.handleToolUse(payload);
          notifyPresence(payload);
          notifyActivity(payload);
          return result;
        }
        if (payload.type === 'tool_approval_needed') {
          const result = await handlers.handleApprovalNeeded(payload);
          notifyPresence(payload);
          notifyActivity(payload);
          return result;
        }
        if (payload.type === 'user_questions_requested') {
          const result = await handlers.handleUserQuestionsRequested(payload);
          notifyPresence(payload);
          notifyActivity(payload);
          return result;
        }
        if (payload.type === 'tool_output_chunk') {
          // W2-1 live tail: DOM-patch only; no presence/activity fan-out (the
          // paired tool_use already flipped the turn into tool work).
          return typeof handlers.handleToolOutputChunk === 'function'
            ? await handlers.handleToolOutputChunk(payload)
            : { buffered: false, terminal: false };
        }
        if (payload.type === 'tool_result') {
          const result = await handlers.handleToolResult(payload);
          // Presence has no use for tool_result; the activity bus does — it
          // clears a pending-approval turn state on the matching result.
          notifyActivity(payload);
          return result;
        }
        if (payload.type === 'stream_reset') return await handlers.handleStreamReset(payload);
        if (payload.type === 'context_compacted') return await handlers.handleContextCompacted(payload);
        if (payload.type === 'context_usage') {
          // Ephemeral meter snapshot: chrome-only, no presence/activity
          // fan-out (it proves nothing about the turn's progress).
          return typeof handlers.handleContextUsage === 'function'
            ? await handlers.handleContextUsage(payload)
            : { buffered: false, terminal: false };
        }
        if (payload.type === 'delta') {
          // Coalesce is decoupled from allowBuffer (finding #31): buffered-event
          // replay passes allowBuffer:false to avoid re-buffering, but it should
          // still fold consecutive deltas through the merge path rather than
          // committing each one synchronously. TYPES_THAT_FLUSH_PENDING already
          // flushes staged deltas before any terminal/tool/phase event, so the
          // coalesced replay commits at the right boundaries.
          const coalesce = Object.prototype.hasOwnProperty.call(callOptions, 'coalesce')
            ? callOptions.coalesce !== false
            : callOptions.allowBuffer !== false;
          streamClientMetrics?.noteDelta(payload.streamId, payload.sessionId);
          const result = await handlers.handleDelta(payload, { coalesce });
          notifyPresence(payload);
          return result;
        }
        if (payload.type === 'question_batch') {
          const result = await handlers.handleQuestionBatch(payload, callOptions);
          safeFinishStreamTerminalCommit(payloadStreamId, true, payload.sessionId);
          return result;
        }
        if (payload.type === 'message_updated') return await handlers.handleMessageUpdated(payload, callOptions);
        if (payload.type === 'complete') {
          const result = await handlers.handleComplete(payload, callOptions);
          streamClientMetrics?.reportTerminal(payload);
          notifyPresence({ ...payload, terminalStatus: 'completed' });
          notifyActivity(payload);
          safeFinishStreamTerminalCommit(payloadStreamId, true, payload.sessionId);
          return result;
        }
        if (payload.type === 'error') {
          const result = await handlers.handleError(payload, callOptions);
          streamClientMetrics?.reportTerminal(payload);
          notifyPresence({
            ...payload,
            terminalStatus: normalizeString(payload.status || payload.terminal_status),
            terminalSubcode: normalizeString(payload.terminal_subcode),
          });
          notifyActivity(payload);
          safeFinishStreamTerminalCommit(payloadStreamId, true, payload.sessionId);
          return result;
        }
      } catch (handlerError) {
        // A throwing terminal handler must still report terminal:true (W3.8):
        // claiming {terminal:false} kept buffered-flush loops and stream
        // lifecycle waiting on a turn that already ended.
        const failedTerminalType = TERMINAL_PAYLOAD_TYPES.has(payload.type);
        if (failedTerminalType && payloadStreamId) {
          safeFinishStreamTerminalCommit(payloadStreamId, false, payload.sessionId);
        }
        appendClientLog('ERROR', 'stream.handler_exception', {
          type: payload.type,
          terminalType: failedTerminalType,
          streamId: String(payload.streamId || '').slice(0, 30),
          sessionId: String(payload.sessionId || '').slice(0, 30),
          message: String(handlerError?.message || handlerError).slice(0, 300),
        });
        return { buffered: false, terminal: failedTerminalType, handlerError: true };
      }
      return { buffered: false, terminal: false };
    }

    async function flushBufferedStreamEvents(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId) {
        return { flushedCount: 0, terminal: false };
      }
      if (flushingStreamIds.has(normalizedStreamId)) {
        return { flushedCount: 0, terminal: false };
      }
      flushingStreamIds.add(normalizedStreamId);
      let terminal = false;
      let degraded = false;
      let flushedCount = 0;
      let discardedCount = 0;
      try {
        const degradation = safeConsumeBufferDegradation(normalizedStreamId);
        if (degradation) {
          const result = await handleStreamPayload(degradation, { allowBuffer: false });
          degraded = result?.degraded === true;
          discardedCount += (state.bufferedStreamEventsByStream.get(normalizedStreamId) || []).length;
          state.bufferedStreamEventsByStream.delete(normalizedStreamId);
          const terminalPayload = normalizeBufferedTerminalPayload(degradation.terminalPayload);
          if (terminalPayload) {
            const terminalResult = await handleStreamPayload(terminalPayload, { allowBuffer: false });
            flushedCount += 1;
            terminal = terminalResult?.terminal === true;
          }
        }
        while (!terminal && !degraded) {
          const bufferedEvents = state.bufferedStreamEventsByStream.get(normalizedStreamId) || [];
          if (!bufferedEvents.length) break;
          state.bufferedStreamEventsByStream.set(normalizedStreamId, []);
          let renderableSinceYield = 0;
          const shouldYieldBetweenBatches = bufferedEvents.length > FLUSH_BATCH_SIZE;
          for (let eventIndex = 0; eventIndex < bufferedEvents.length; eventIndex += 1) {
            const payload = bufferedEvents[eventIndex];
            const result = await handleStreamPayload(payload, { allowBuffer: false, coalesce: true });
            flushedCount += 1;
            if (result?.terminal) {
              // Terminal is absorbing (CTL-003): the unprocessed tail belongs
              // to protocol drift or a dead generation — drop it rather than
              // replaying it into the settled turn (a trailing error would
              // fabricate a failure bubble/toast after a successful answer).
              terminal = true;
              discardedCount += bufferedEvents.length - (eventIndex + 1);
              break;
            }
            if (
              shouldYieldBetweenBatches
              && isRenderableBufferedStreamEvent(payload)
            ) {
              renderableSinceYield += 1;
              if (renderableSinceYield >= FLUSH_BATCH_SIZE) {
                renderableSinceYield = 0;
                // Flush before yielding so replay paints incrementally.
                safeFlushPendingCommit(normalizedStreamId);
                await waitForRenderFrame();
              }
            }
          }
        }
      } finally {
        // Flush once in finally so the last staged delta is visible before replay acknowledgment.
        safeFlushPendingCommit(normalizedStreamId);
        flushingStreamIds.delete(normalizedStreamId);
        const trailing = state.bufferedStreamEventsByStream.get(normalizedStreamId) || [];
        if (terminal || trailing.length === 0) {
          if (terminal) {
            discardedCount += trailing.length;
          }
          state.bufferedStreamEventsByStream.delete(normalizedStreamId);
        }
        if (discardedCount > 0) {
          appendClientLog('INFO', 'stream.buffered_tail_dropped_terminal', {
            streamId: String(normalizedStreamId).slice(0, 30),
            discardedCount,
            flushedCount,
          });
        }
        // Let the envelope receipt tracker count + ack the now-replayed buffered
        // envelopes for this stream (finding #8). Terminal-discarded frames are
        // reported so receipt accounting reflects a deliberate drop, not a
        // successful replay.
        if (typeof onBufferedStreamFlushed === 'function') {
          try {
            onBufferedStreamFlushed(normalizedStreamId, { terminal, degraded, discardedCount });
          } catch (_error) {
            // Receipt bookkeeping is best-effort; never break the flush.
          }
        }
      }
      const result = { flushedCount, terminal, discardedCount };
      if (degraded) result.degraded = true;
      return result;
    }

    function dropBufferedStreamEvents(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      if (normalizedStreamId) {
        flushingStreamIds.delete(normalizedStreamId);
        state.bufferedStreamEventsByStream.delete(normalizedStreamId);
        safeConsumeBufferDegradation(normalizedStreamId);
      }
    }

    return {
      handleStreamPayload,
      flushBufferedStreamEvents,
      dropBufferedStreamEvents,
    };
  }

  return { createStreamDispatchRouter };
});
