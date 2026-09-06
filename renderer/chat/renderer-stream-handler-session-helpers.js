/* renderer/chat/renderer-stream-handler-session-helpers.js -- buffer/preflight management + per-session composer/approval helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerSessionHelpers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const streamBufferUtils = (typeof globalThis !== 'undefined' && globalThis.rendererStreamBufferUtils)
    || (typeof require === 'function' ? require('./renderer-stream-buffer-utils') : null);
  if (!streamBufferUtils
    || typeof streamBufferUtils.appendSemanticStreamEvent !== 'function'
    || typeof streamBufferUtils.measureStreamEventBytes !== 'function') {
    throw new Error('renderer-stream-buffer-utils must load before renderer-stream-handler-session-helpers');
  }
  const { appendSemanticStreamEvent, measureStreamEventBytes } = streamBufferUtils;
  const BUFFERED_TERMINAL_TYPES = new Set(['complete', 'error', 'cancelled', 'question_batch']);

  function findBufferedTerminalPayload(events) {
    const terminal = (Array.isArray(events) ? events : []).findLast((event) => (
      BUFFERED_TERMINAL_TYPES.has(String(event?.type || '').trim().toLowerCase())
    ));
    if (!terminal) return null;
    const payload = { ...terminal };
    payload.type = String(payload.type || '').trim().toLowerCase();
    delete payload._bufferedAt;
    delete payload._bufferedByteSize;
    return payload;
  }

  function createStreamSessionHelpers(options = {}) {
    const {
      state,
      normalizeId,
      appendClientLog,
      multiStreamController,
      maxBufferPerStream,
      bufferExpiryMs,
      maxBufferedStreams,
      maxBufferedEventsTotal,
      maxBufferedBytesTotal,
      bufferSweepIntervalMs,
      setTimeoutImpl,
      clearTimeoutImpl,
      timelineVisibilityTracker,
      isCurrentSession,
      isVisibleChatSession,
      refreshSessionSummaries,
      queueRender,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      setTurnStatusPill,
      clearTurnStatusPill,
      clearTurnStatusPillSources,
      showToastMessage,
      toastSource,
      approvalToastSessionIds,
      resolveWorkspaceActivator,
    } = options || {};

    if (!state || typeof state !== 'object') {
      throw new Error('createStreamSessionHelpers requires options.state');
    }
    if (typeof normalizeId !== 'function') {
      throw new Error('createStreamSessionHelpers requires normalizeId');
    }
    if (typeof appendClientLog !== 'function') {
      throw new Error('createStreamSessionHelpers requires appendClientLog');
    }
    if (typeof isCurrentSession !== 'function' || typeof isVisibleChatSession !== 'function') {
      throw new Error('createStreamSessionHelpers requires isCurrentSession and isVisibleChatSession');
    }
    if (!(approvalToastSessionIds instanceof Set)) {
      throw new Error('createStreamSessionHelpers requires approvalToastSessionIds (Set)');
    }

    const MAX_BUFFER_PER_STREAM = Number(maxBufferPerStream) > 0 ? Number(maxBufferPerStream) : 500;
    const BUFFER_EXPIRY_MS = Number(bufferExpiryMs) > 0 ? Number(bufferExpiryMs) : 60000;
    // CTL-014: per-stream cap above bounds one runaway stream; these three
    // bound the WHOLE pre-session buffer (many distinct stream ids racing
    // their session record) so a flood of unrelated streams can't grow the
    // map unbounded while every individual stream still looks "under cap".
    const MAX_BUFFERED_STREAMS = Number(maxBufferedStreams) > 0 ? Number(maxBufferedStreams) : 64;
    const MAX_BUFFERED_EVENTS_TOTAL = Number(maxBufferedEventsTotal) > 0 ? Number(maxBufferedEventsTotal) : 2000;
    const MAX_BUFFERED_BYTES_TOTAL = Number(maxBufferedBytesTotal) > 0 ? Number(maxBufferedBytesTotal) : 4_000_000;
    const MAX_DEGRADED_STREAMS = Math.max(MAX_BUFFERED_STREAMS, 256);
    const BUFFER_SWEEP_INTERVAL_MS = Number(bufferSweepIntervalMs) > 0 ? Number(bufferSweepIntervalMs) : 30_000;
    const safeSetTimeoutImpl = typeof setTimeoutImpl === 'function'
      ? setTimeoutImpl
      : (typeof globalThis.setTimeout === 'function' ? globalThis.setTimeout.bind(globalThis) : () => 0);
    const safeClearTimeoutImpl = typeof clearTimeoutImpl === 'function'
      ? clearTimeoutImpl
      : (typeof globalThis.clearTimeout === 'function' ? globalThis.clearTimeout.bind(globalThis) : () => {});
    const safeQueueRender = typeof queueRender === 'function' ? queueRender : () => {};
    const safeRefreshSessionSummaries = typeof refreshSessionSummaries === 'function'
      ? refreshSessionSummaries
      : async () => {};
    const safeSetComposerNotice = typeof setComposerStatusNotice === 'function' ? setComposerStatusNotice : () => {};
    const safeClearComposerNotice = typeof clearComposerStatusNotice === 'function' ? clearComposerStatusNotice : () => {};
    const safeSetTurnStatusPill = typeof setTurnStatusPill === 'function' ? setTurnStatusPill : () => {};
    const safeClearTurnStatusPill = typeof clearTurnStatusPill === 'function' ? clearTurnStatusPill : () => {};
    const safeClearTurnStatusPillSources = typeof clearTurnStatusPillSources === 'function'
      ? clearTurnStatusPillSources
      : (list) => {
        const items = Array.isArray(list) ? list : [];
        for (let i = 0; i < items.length; i += 1) {
          safeClearTurnStatusPill(items[i]);
        }
      };
    const safeShowToast = typeof showToastMessage === 'function' ? showToastMessage : () => {};
    const TOAST_SOURCE = toastSource || { chatStream: 'chat-stream' };
    // Degraded markers are bounded by MAX_DEGRADED_STREAMS, not time: an active
    // unrecovered stream must remain routed to canonical recovery until consumed.
    if (!(state.degradedBufferedStreamsByStream instanceof Map)) {
      state.degradedBufferedStreamsByStream = new Map();
    }

    function markHiddenRenderableEvent(payload, eventType) {
      return timelineVisibilityTracker?.markRenderableEvent?.(payload?.sessionId, {
        streamId: payload?.streamId,
        eventType,
        visible: isVisibleChatSession(payload?.sessionId),
        current: isCurrentSession(payload?.sessionId),
      });
    }

    function markHiddenRenderableRender(details) {
      return timelineVisibilityTracker?.markRenderableEvent?.(details?.sessionId, {
        streamId: details?.streamId,
        eventType: details?.eventType,
        visible: details?.visible,
        current: details?.current,
      });
    }

    function resolvePayloadSessionId(payload) {
      const payloadSessionId = normalizeId(payload?.sessionId);
      if (payloadSessionId) return payloadSessionId;
      const streamId = normalizeId(payload?.streamId);
      if (!streamId || !multiStreamController) return '';
      return String(
        multiStreamController.getSessionIdForStream(streamId)
        || multiStreamController.findPreflightSessionIdByStream?.(streamId)
        || ''
      ).trim();
    }

    function getPreflightForPayload(payload) {
      const streamId = normalizeId(payload?.streamId);
      const sessionId = resolvePayloadSessionId(payload);
      if (multiStreamController?.getPreflight && sessionId) {
        let resolvedSessionId = sessionId;
        let preflight = multiStreamController.getPreflight(sessionId);
        if (!preflight) {
          const candidateSessionIds = multiStreamController
            .getPreflightSessionIds()
            .filter((candidateSessionId) => {
              const candidate = multiStreamController.getPreflight(candidateSessionId);
              const candidateStreamId = normalizeId(candidate?.streamId);
              return !candidateStreamId || candidateStreamId === streamId;
            });
          if (candidateSessionIds.length === 1) {
            const candidateSessionId = candidateSessionIds[0];
            preflight = multiStreamController.getPreflight(candidateSessionId);
            if (preflight && candidateSessionId !== sessionId) {
              multiStreamController.clearPreflight(candidateSessionId);
              preflight.sessionId = sessionId;
              multiStreamController.registerPreflight(sessionId, preflight);
            }
            resolvedSessionId = sessionId;
          }
        }
        return { sessionId: resolvedSessionId, preflight };
      }
      const legacyPreflight =
        state.sendPreflight && typeof state.sendPreflight === 'object' ? state.sendPreflight : null;
      if (!legacyPreflight || !sessionId) {
        return { sessionId, preflight: null };
      }
      if (streamId && legacyPreflight.streamId && normalizeId(legacyPreflight.streamId) !== streamId) {
        return { sessionId, preflight: null };
      }
      return { sessionId, preflight: legacyPreflight };
    }

    function notePreflightEvent(payload, eventType) {
      const { sessionId, preflight } = getPreflightForPayload(payload);
      const streamId = normalizeId(payload?.streamId);
      if (!preflight || preflight.firstEventLogged || !streamId) {
        return;
      }
      preflight.streamId = streamId;
      preflight.firstEventLogged = true;
      appendClientLog('INFO', 'chat.send_first_event', {
        sessionId,
        streamId,
        type: String(eventType || payload?.type || 'unknown'),
        latencyMs: Math.max(Date.now() - Number(preflight.startedAt || Date.now()), 0),
      });
      if (!preflight.pending) {
        multiStreamController?.clearPreflight?.(sessionId);
      }
    }

    function hasSessionState(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      return Boolean(
        normalizedSessionId
        && (
          state.messagesBySession.has(normalizedSessionId)
          || state.interactiveDraftsBySession.has(normalizedSessionId)
          || state.sessions.some((session) => normalizeId(session?.id) === normalizedSessionId)
          || normalizedSessionId === normalizeId(state.currentSessionId)
        )
      );
    }

    function shouldBufferStreamEvent(payload) {
      const streamId = normalizeId(payload?.streamId);
      const { sessionId, preflight } = getPreflightForPayload(payload);
      if (!streamId || !sessionId || !preflight || hasSessionState(sessionId)) {
        return false;
      }
      const preflightStreamId = normalizeId(preflight.streamId);
      return !preflightStreamId || preflightStreamId === streamId;
    }

    // Totals are recomputed from the live map on each enforcement pass, not
    // tracked as running counters: renderer-stream-handler-dispatch.js
    // flushes buffered streams by mutating state.bufferedStreamEventsByStream
    // directly, so counters would ratchet upward forever and eventually
    // evict every stream on sight. The walk is bounded by the caps
    // themselves and only runs on the rare pre-session buffering path.
    let sweepTimerHandle = null;

    function measureBufferedTotals() {
      let events = 0;
      let bytes = 0;
      for (const queue of state.bufferedStreamEventsByStream.values()) {
        events += queue.length;
        bytes += measureStreamEventBytes(queue);
      }
      return { events, bytes };
    }

    function armBufferSweepTimer() {
      if (sweepTimerHandle !== null
        || state.bufferedStreamEventsByStream.size === 0) {
        return;
      }
      sweepTimerHandle = safeSetTimeoutImpl(runBufferSweep, BUFFER_SWEEP_INTERVAL_MS);
    }

    function disarmBufferSweepTimer() {
      if (sweepTimerHandle === null) {
        return;
      }
      safeClearTimeoutImpl(sweepTimerHandle);
      sweepTimerHandle = null;
    }

    function runBufferSweep() {
      sweepTimerHandle = null;
      evictStaleBufferedEvents();
      // Rearm while the buffer is non-empty (no-op otherwise) so expiry keeps
      // running independent of renders until the map drains.
      armBufferSweepTimer();
    }

    // Total-cap eviction sacrifices whole streams, never the stream the
    // caller is actively appending to. Among the remaining candidates it
    // drops the SMALLEST queue first (ties broken by Map insertion order) —
    // that frees a stream slot at the lowest event-loss cost, and for
    // equal-sized streams (the common case) it degenerates to oldest-first.
    function pickEvictionVictim(activeStreamId) {
      let victimStreamId = null;
      let victimSize = Infinity;
      for (const [candidateStreamId, events] of state.bufferedStreamEventsByStream) {
        if (candidateStreamId === activeStreamId) {
          continue;
        }
        if (events.length < victimSize) {
          victimSize = events.length;
          victimStreamId = candidateStreamId;
        }
      }
      return victimStreamId;
    }

    function markBufferedStreamDegraded(streamId, reason, events) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId || state.degradedBufferedStreamsByStream.has(normalizedStreamId)) return;
      const sourceEvents = Array.isArray(events) ? events : [];
      const sample = sourceEvents[0] || {};
      const terminalPayload = findBufferedTerminalPayload(sourceEvents);
      state.degradedBufferedStreamsByStream.set(normalizedStreamId, {
        type: 'buffer_degraded',
        streamId: normalizedStreamId,
        sessionId: normalizeId(sample.sessionId),
        reason,
        droppedEvents: sourceEvents.length,
        droppedBytes: measureStreamEventBytes(sourceEvents),
        ...(terminalPayload ? { terminalPayload } : {}),
        _bufferedAt: Date.now(),
      });
      while (state.degradedBufferedStreamsByStream.size > MAX_DEGRADED_STREAMS) {
        const oldestStreamId = state.degradedBufferedStreamsByStream.keys().next().value;
        state.degradedBufferedStreamsByStream.delete(oldestStreamId);
        appendClientLog('WARN', 'stream.buffer_degraded_marker_evicted', {
          streamId: String(oldestStreamId || '').slice(0, 30),
          markerCap: MAX_DEGRADED_STREAMS,
        });
      }
    }

    function consumeBufferedStreamDegradation(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      const marker = state.degradedBufferedStreamsByStream.get(normalizedStreamId) || null;
      if (marker) state.degradedBufferedStreamsByStream.delete(normalizedStreamId);
      return marker;
    }

    function enforceTotalBufferCaps(activeStreamId) {
      let evictedStreams = 0;
      let droppedEvents = 0;
      let reason = null;
      const totals = measureBufferedTotals();
      for (;;) {
        const overStreams = state.bufferedStreamEventsByStream.size > MAX_BUFFERED_STREAMS;
        const overEvents = totals.events > MAX_BUFFERED_EVENTS_TOTAL;
        const overBytes = totals.bytes > MAX_BUFFERED_BYTES_TOTAL;
        if (!overStreams && !overEvents && !overBytes) {
          break;
        }
        if (!reason) {
          reason = overStreams ? 'stream_cap' : (overEvents ? 'event_cap' : 'byte_cap');
        }
        const victimStreamId = pickEvictionVictim(activeStreamId);
        if (!victimStreamId) {
          // Only the active stream is left; it is never trimmed by total
          // caps, so the budget stays over until later events age out.
          break;
        }
        const victimEvents = state.bufferedStreamEventsByStream.get(victimStreamId) || [];
        markBufferedStreamDegraded(victimStreamId, reason, victimEvents);
        state.bufferedStreamEventsByStream.delete(victimStreamId);
        totals.events -= victimEvents.length;
        totals.bytes -= measureStreamEventBytes(victimEvents);
        evictedStreams += 1;
        droppedEvents += victimEvents.length;
      }
      if (evictedStreams > 0) {
        appendClientLog('WARN', 'stream.buffered_streams_evicted', {
          reason,
          evictedStreams,
          droppedEvents,
          bufferedStreams: state.bufferedStreamEventsByStream.size,
          bufferedEvents: totals.events,
        });
      }
    }

    function bufferStreamEvent(payload) {
      const streamId = normalizeId(payload?.streamId);
      if (!streamId) {
        return;
      }
      const degradedMarker = state.degradedBufferedStreamsByStream.get(streamId);
      if (degradedMarker) {
        // Deltas stay dropped, but the newest terminal must reach the replay
        // or the stream is left registered and non-terminal forever.
        if (BUFFERED_TERMINAL_TYPES.has(String(payload?.type || '').trim().toLowerCase())) {
          degradedMarker.terminalPayload = findBufferedTerminalPayload([payload]);
        }
        return;
      }
      const bufferedEvents = state.bufferedStreamEventsByStream.get(streamId) || [];
      appendSemanticStreamEvent(bufferedEvents, payload);
      if (bufferedEvents.length > MAX_BUFFER_PER_STREAM
        || measureStreamEventBytes(bufferedEvents) > MAX_BUFFERED_BYTES_TOTAL) {
        markBufferedStreamDegraded(streamId, bufferedEvents.length > MAX_BUFFER_PER_STREAM
          ? 'per_stream_event_cap'
          : 'per_stream_byte_cap', bufferedEvents);
        state.bufferedStreamEventsByStream.delete(streamId);
        appendClientLog('WARN', 'stream.buffer_degraded', {
          streamId: String(streamId).slice(0, 30),
          reason: state.degradedBufferedStreamsByStream.get(streamId)?.reason,
          droppedEvents: bufferedEvents.length,
        });
        return;
      }
      state.bufferedStreamEventsByStream.set(streamId, bufferedEvents);
      enforceTotalBufferCaps(streamId);
      const totals = measureBufferedTotals();
      if (totals.events > MAX_BUFFERED_EVENTS_TOTAL || totals.bytes > MAX_BUFFERED_BYTES_TOTAL) {
        const activeEvents = state.bufferedStreamEventsByStream.get(streamId) || [];
        markBufferedStreamDegraded(streamId, totals.events > MAX_BUFFERED_EVENTS_TOTAL
          ? 'total_event_cap'
          : 'total_byte_cap', activeEvents);
        state.bufferedStreamEventsByStream.delete(streamId);
      }
      armBufferSweepTimer();
    }

    function evictStaleBufferedEvents() {
      const cutoff = Date.now() - BUFFER_EXPIRY_MS;
      for (const [streamId, events] of state.bufferedStreamEventsByStream) {
        if (events.length === 0 || events.some((event) => event._bufferedAt > cutoff)) continue;
        markBufferedStreamDegraded(streamId, 'buffer_expired', events);
        state.bufferedStreamEventsByStream.delete(streamId);
        const marker = state.degradedBufferedStreamsByStream.get(streamId);
        appendClientLog('WARN', 'stream.buffer_degraded', {
          streamId: String(streamId).slice(0, 30),
          reason: marker?.reason,
          droppedEvents: marker?.droppedEvents,
          droppedBytes: marker?.droppedBytes,
        });
      }
      if (state.bufferedStreamEventsByStream.size === 0) {
        disarmBufferSweepTimer();
      }
    }

    function clearBufferedStreamEvents() {
      state.bufferedStreamEventsByStream.clear();
      state.degradedBufferedStreamsByStream.clear();
      disarmBufferSweepTimer();
    }

    async function refreshSessionMetadata(sessionId, options = {}) {
      await safeRefreshSessionSummaries(sessionId, { preserveCurrentSession: true });
      if (options.signal?.aborted === true) return false;
      if (options.guard && typeof options.guard.mutate === 'function') {
        return options.guard.mutate(() => safeQueueRender({ full: true }));
      }
      safeQueueRender({ full: true });
      return true;
    }

    function setSessionComposerNotice(sessionId, message, callOptions) {
      if (isCurrentSession(sessionId)) {
        safeSetComposerNotice(message, callOptions);
      }
    }

    function clearSessionComposerNotice(sessionId) {
      if (isCurrentSession(sessionId)) {
        safeClearComposerNotice();
      }
    }

    function setSessionTurnStatusPill(sessionId, source, payload) {
      if (isCurrentSession(sessionId)) {
        safeSetTurnStatusPill(source, payload);
      }
    }

    function clearSessionTurnStatusPill(sessionId, source) {
      if (isCurrentSession(sessionId)) {
        safeClearTurnStatusPill(source);
      }
    }

    function clearSessionTurnStatusPillSources(sessionId, sources) {
      if (isCurrentSession(sessionId)) {
        safeClearTurnStatusPillSources(sources);
      }
    }

    function activateApprovalSession(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return;
      }
      const activator = typeof resolveWorkspaceActivator === 'function'
        ? resolveWorkspaceActivator()
        : (globalThis.rendererWorkspaceChromeController?.activateSession
          || globalThis.workspaceController?.activateSession
          || globalThis.workspaceChromeController?.activateSession);
      if (typeof activator === 'function') {
        activator(normalizedSessionId);
      }
    }

    function showApprovalToast(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return;
      }
      if (approvalToastSessionIds.has(normalizedSessionId)) {
        return;
      }
      if (approvalToastSessionIds.size >= 3) {
        return;
      }
      approvalToastSessionIds.add(normalizedSessionId);
      safeShowToast('A background session is waiting for tool approval.', {
        title: 'Approval Needed',
        tone: 'warning',
        sticky: true,
        source: TOAST_SOURCE.chatStream,
        dedupeKey: `${TOAST_SOURCE.chatStream}:approval:${normalizedSessionId}`,
        actions: [{
          id: `open_session_${normalizedSessionId}`,
          label: 'Open Session',
          kind: 'primary',
          onClick: () => activateApprovalSession(normalizedSessionId),
        }],
      });
    }

    return {
      markHiddenRenderableEvent,
      markHiddenRenderableRender,
      resolvePayloadSessionId,
      getPreflightForPayload,
      notePreflightEvent,
      hasSessionState,
      shouldBufferStreamEvent,
      bufferStreamEvent,
      consumeBufferedStreamDegradation,
      evictStaleBufferedEvents,
      clearBufferedStreamEvents,
      refreshSessionMetadata,
      setSessionComposerNotice,
      clearSessionComposerNotice,
      setSessionTurnStatusPill,
      clearSessionTurnStatusPill,
      clearSessionTurnStatusPillSources,
      activateApprovalSession,
      showApprovalToast,
    };
  }

  return { createStreamSessionHelpers };
});
