const {
  normalizeEventPayload,
  normalizeToken,
  invokeSafely,
  createStreamStats,
  recordRendererForwardFailure,
  updateStreamStats,
  buildTerminalSummary,
  buildUsageMetadata,
  mergeDeltaPayloads,
  isTerminalChatStreamType,
} = require('./chat-stream-bridge-support');

const MAX_STREAM_STATS_ENTRIES = 64;

// Coalesce same-stream deltas to keep reasoning-heavy models from saturating
// Chromium IPC. content/entriesDelta are incremental; aggregate is cumulative.
// One merged event per frame preserves renderer semantics without main-process
// stalls while the sidecar continues streaming.
const DELTA_COALESCE_WINDOW_MS = 50;
// A fast model fills a 50 ms window with 4-5 tokens, which paints as visible
// word-group jumps. Once a window holds two deltas of one stream it flushes as
// soon as one frame has passed since it opened. A stream at <=40 tok/s (the
// ratchet fixture in tests/streaming-ipc-bytes.load) sends exactly what it sent
// before. A faster stream trades per-event overhead for smoothness: every event
// still carries at least two of its deltas, at no more than one per frame.
const DELTA_EARLY_FLUSH_DELTAS = 2;
const DELTA_MIN_FLUSH_INTERVAL_MS = 16;

function createChatStreamBridge({
  sendBridgeEvent = () => {},
  log = () => {},
  usageHistory = null,
  now = () => Date.now(),
  setCoalesceTimer = (fn, ms) => setTimeout(fn, ms),
  clearCoalesceTimer = (handle) => clearTimeout(handle),
} = {}) {
  const statsByStream = new Map();
  const pendingDeltaByStream = new Map(); // streamId -> { payload }
  let flushTimerHandle = null;
  let coalesceWindowStartedAtMs = 0;
  let flushDueAtMs = 0;
  const deltasInWindowByStream = new Map(); // streamId -> deltas since the window opened

  function trimStreamMap(map, maxEntries, protectedStreamId = '') {
    const protectedKey = normalizeToken(protectedStreamId);
    for (const streamId of map.keys()) {
      if (map.size <= maxEntries) {
        break;
      }
      if (streamId === protectedKey) {
        continue;
      }
      map.delete(streamId);
    }
  }

  function clearCoalesceTimerIfIdle() {
    if (pendingDeltaByStream.size > 0) return;
    deltasInWindowByStream.clear();
    if (flushTimerHandle) {
      clearCoalesceTimer(flushTimerHandle);
      flushTimerHandle = null;
    }
  }

  function flushAllPendingDeltas() {
    const entries = [...pendingDeltaByStream.values()];
    pendingDeltaByStream.clear();
    for (const entry of entries) {
      const flushError = invokeSafely(sendBridgeEvent, 'chat.onStream', entry.payload);
      if (flushError) {
        recordRendererForwardFailure(
          statsByStream.get(normalizeToken(entry.payload?.streamId)),
          flushError
        );
      }
    }
    clearCoalesceTimerIfIdle();
  }

  function flushAllPendingCoalesced() {
    flushTimerHandle = null;
    deltasInWindowByStream.clear();
    if (pendingDeltaByStream.size === 0) {
      return;
    }
    flushAllPendingDeltas();
  }

  function flushPendingDeltaForStream(streamId) {
    if (!streamId) return '';
    deltasInWindowByStream.delete(streamId);
    const entry = pendingDeltaByStream.get(streamId);
    if (!entry) return '';
    pendingDeltaByStream.delete(streamId);
    clearCoalesceTimerIfIdle();
    const flushError = invokeSafely(sendBridgeEvent, 'chat.onStream', entry.payload);
    if (flushError) {
      recordRendererForwardFailure(statsByStream.get(streamId), flushError);
    }
    return flushError;
  }

  function scheduleDeltaFlush() {
    if (flushTimerHandle) return;
    coalesceWindowStartedAtMs = now();
    flushDueAtMs = coalesceWindowStartedAtMs + DELTA_COALESCE_WINDOW_MS;
    flushTimerHandle = setCoalesceTimer(flushAllPendingCoalesced, DELTA_COALESCE_WINDOW_MS);
  }

  // Called once per incoming delta event, after it was queued.
  function pullDeltaFlushForward(streamId) {
    if (!flushTimerHandle || !streamId) return;
    const deltasInWindow = (deltasInWindowByStream.get(streamId) || 0) + 1;
    deltasInWindowByStream.set(streamId, deltasInWindow);
    if (deltasInWindow < DELTA_EARLY_FLUSH_DELTAS) return;
    const dueAtMs = coalesceWindowStartedAtMs + DELTA_MIN_FLUSH_INTERVAL_MS;
    if (dueAtMs >= flushDueAtMs) return;
    const nowMs = now();
    clearCoalesceTimer(flushTimerHandle);
    flushTimerHandle = null;
    if (nowMs >= dueAtMs) {
      flushAllPendingCoalesced();
      return;
    }
    flushDueAtMs = dueAtMs;
    flushTimerHandle = setCoalesceTimer(flushAllPendingCoalesced, dueAtMs - nowMs);
  }

  function queueDeltaForCoalesce(payload, streamId) {
    if (!streamId) {
      // Can't coalesce without a stream key; send through immediately.
      return invokeSafely(sendBridgeEvent, 'chat.onStream', payload);
    }
    const existing = pendingDeltaByStream.get(streamId);
    const merged = existing ? mergeDeltaPayloads(existing.payload, payload) : payload;
    pendingDeltaByStream.set(streamId, { payload: merged });
    scheduleDeltaFlush();
    return '';
  }

  function getStreamStats(payload, timestampMs) {
    const streamId = normalizeToken(payload?.streamId);
    if (!streamId) {
      return null;
    }
    let stats = statsByStream.get(streamId);
    if (!stats) {
      stats = createStreamStats(payload, timestampMs);
      statsByStream.set(streamId, stats);
      trimStreamMap(statsByStream, MAX_STREAM_STATS_ENTRIES, streamId);
    }
    return stats;
  }

  function resetStream(streamId) {
    const normalized = normalizeToken(streamId);
    statsByStream.delete(normalized);
    // Drop any pending coalesced delta for the stream — caller is signalling
    // the stream is no longer active and any buffered chunk would be stale.
    if (normalized && pendingDeltaByStream.has(normalized)) {
      pendingDeltaByStream.delete(normalized);
      clearCoalesceTimerIfIdle();
    }
  }

  function handleEvent(event) {
    const payload = normalizeEventPayload(event);
    const type = normalizeToken(payload.type);
    const timestampMs = now();
    const isTerminal = isTerminalChatStreamType(type);
    const streamId = normalizeToken(payload.streamId);

    const stats = getStreamStats(payload, timestampMs);
    // Coalesce deltas; flush them before other events to preserve ordering.
    // Incremental content/entriesDelta merge while cumulative aggregate wins.
    let rendererForwardError;
    if (type === 'delta') {
      rendererForwardError = queueDeltaForCoalesce(payload, streamId);
      pullDeltaFlushForward(streamId);
    } else {
      if (streamId) {
        flushPendingDeltaForStream(streamId);
      } else if (pendingDeltaByStream.size > 0) {
        // Unkeyed event under load — flush everything to keep ordering safe.
        flushAllPendingDeltas();
      }
      rendererForwardError = invokeSafely(sendBridgeEvent, 'chat.onStream', payload);
    }
    if (rendererForwardError) {
      recordRendererForwardFailure(stats, rendererForwardError);
    }
    const shouldLogFirstForward = stats && !stats.firstNotificationLogged && !rendererForwardError;
    updateStreamStats(stats, payload, type);
    if (shouldLogFirstForward) {
      stats.firstNotificationLogged = true;
      invokeSafely(
        log,
        'INFO',
        'chat.first_notification_forwarded',
        {
          type,
          streamId: streamId || '',
          stream_id: streamId || '',
          requestId: stats.requestId || '',
          request_id: stats.requestId || '',
          traceId: stats.traceId || '',
          trace_id: stats.traceId || '',
          sessionId: stats.sessionId || '',
          elapsedMs: Math.max(timestampMs - Number(stats.startedAtMs || timestampMs), 0),
        }
      );
    }

    let usageRecordError = '';
    if (
      isTerminal
      && usageHistory
      && typeof usageHistory.recordTurnUsage === 'function'
    ) {
      const usageMetadata = buildUsageMetadata(payload, type, stats, timestampMs);
      const terminalUsage = payload.usage && typeof payload.usage === 'object'
        && !Array.isArray(payload.usage)
        ? payload.usage
        : {};
      usageRecordError = invokeSafely(
        usageHistory.recordTurnUsage.bind(usageHistory),
        usageMetadata.sessionId,
        terminalUsage,
        usageMetadata
      );
      if (
        usageRecordError
        && typeof usageHistory.reportRecordFailure === 'function'
      ) {
        invokeSafely(
          usageHistory.reportRecordFailure.bind(usageHistory),
          {
            sessionId: usageMetadata.sessionId,
            error: usageRecordError,
          }
        );
      }
    }

    if (!isTerminal) {
      return;
    }

    try {
      const summary = buildTerminalSummary(payload, type, stats, timestampMs);
      if (usageRecordError) {
        summary.usageRecordingFailed = true;
        summary.usageRecordingError = 'record_failed';
      }
      invokeSafely(
        log,
        type === 'error' ? 'ERROR' : 'INFO',
        'chat.stream_summary',
        summary
      );
    } finally {
      if (streamId) {
        statsByStream.delete(streamId);
      }
    }
  }

  return {
    handleEvent,
    resetStream,
  };
}

module.exports = {
  createChatStreamBridge,
};
