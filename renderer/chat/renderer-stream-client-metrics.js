/* renderer/chat/renderer-stream-client-metrics.js -- per-stream renderer paint/render counters for turn diagnostics (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamClientMetricsModule = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TRACKED_STREAMS = 32;
  const MAX_UNKNOWN_RENDER_KIND_WARNINGS = 8;
  const MAX_RENDER_KIND_LENGTH = 80;
  const MAX_REASONING_FALLBACK_REASONS = 32;
  const MAX_REASONING_FALLBACK_REASON_LENGTH = 64;
  // Warn when the last-delta-to-terminal gap exceeds 1000 ms.
  const TERMINAL_GAP_WARN_MS = 1000;

  // Ship bounded paint counters in client_timing so diagnostics can identify streams that received deltas without patches.
  function createStreamClientMetrics({
    now = () => Date.now(),
    ship = (payload) => globalThis.jennyShell?.diagnostics?.reportClientStreamMetrics?.(payload),
    appendClientLog = (...args) => globalThis.appendClientLog?.(...args),
  } = {}) {
    const byStreamId = new Map();
    const streamIdBySessionId = new Map();
    const warnedUnknownRenderKinds = new Set();
    let lastDeltaStreamId = '';

    function normalizeId(value) {
      return String(value || '').trim();
    }

    function ensureEntry(streamId, sessionId) {
      let entry = byStreamId.get(streamId);
      if (!entry) {
        entry = {
          sessionId,
          deltasReceived: 0,
          firstDeltaAtMs: null,
          lastDeltaAtMs: null,
          firstPaintAtMs: null,
          streamRevealPatchesApplied: 0,
          fullRenders: 0,
          noopRenders: 0,
          reasoningHeaderRewrites: 0,
          reasoningHeaderMorphs: 0,
          reasoningBodyRenders: 0,
          reasoningBodyFullRenders: 0,
          reasoningBodyFallbackReasons: Object.create(null),
          reasoningBodyRenderMsMax: 0,
          reasoningPeakEntryChars: 0,
          mailboxPeakDepth: 0,
          mailboxPeakQueuedBytes: 0,
          mailboxDropped: 0,
          // Post-approval flicker RCA: which render gate forced each full
          // render. Bounded by the fixed reason vocabulary the renderer
          // passes, so this can never grow with transcript size.
          fullRenderReasons: Object.create(null),
        };
        byStreamId.set(streamId, entry);
        if (byStreamId.size > MAX_TRACKED_STREAMS) {
          const oldestStreamId = byStreamId.keys().next().value;
          const oldest = byStreamId.get(oldestStreamId);
          byStreamId.delete(oldestStreamId);
          if (oldest && streamIdBySessionId.get(oldest.sessionId) === oldestStreamId) {
            streamIdBySessionId.delete(oldest.sessionId);
          }
        }
      }
      if (sessionId) {
        entry.sessionId = sessionId;
        streamIdBySessionId.set(sessionId, streamId);
      }
      return entry;
    }

    function noteDelta(streamId, sessionId) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId) {
        return;
      }
      const entry = ensureEntry(normalizedStreamId, normalizeId(sessionId));
      lastDeltaStreamId = normalizedStreamId;
      entry.deltasReceived += 1;
      entry.lastDeltaAtMs = now();
      if (entry.firstDeltaAtMs == null) {
        entry.firstDeltaAtMs = entry.lastDeltaAtMs;
      }
    }

    function noteMailbox(streamId, sessionId, { peakDepth, peakQueuedBytes, dropped } = {}) {
      const normalizedStreamId = normalizeId(streamId);
      // Mailbox traffic must not create entries and evict live paint counters;
      // noteDelta remains the sole owner of stream-entry creation.
      const entry = byStreamId.get(normalizedStreamId);
      if (!entry) return;
      entry.mailboxPeakDepth = Math.max(entry.mailboxPeakDepth, Number(peakDepth) || 0);
      entry.mailboxPeakQueuedBytes = Math.max(
        entry.mailboxPeakQueuedBytes,
        Number(peakQueuedBytes) || 0,
      );
      entry.mailboxDropped = Math.max(entry.mailboxDropped, Number(dropped) || 0);
    }

    function noteReasoningBodyRender({ mode, fallbackReason, durationMs, entryChars } = {}) {
      const entry = lastDeltaStreamId ? byStreamId.get(lastDeltaStreamId) : null;
      if (!entry) return;
      entry.reasoningBodyRenders += 1;
      if (mode === 'full') entry.reasoningBodyFullRenders += 1;
      const reason = normalizeId(fallbackReason).slice(0, MAX_REASONING_FALLBACK_REASON_LENGTH);
      if (reason && (entry.reasoningBodyFallbackReasons[reason]
          || Object.keys(entry.reasoningBodyFallbackReasons).length < MAX_REASONING_FALLBACK_REASONS)) {
        entry.reasoningBodyFallbackReasons[reason] =
          (entry.reasoningBodyFallbackReasons[reason] || 0) + 1;
      }
      const duration = Number(durationMs);
      if (Number.isFinite(duration) && duration >= 0) {
        entry.reasoningBodyRenderMsMax = Math.max(
          entry.reasoningBodyRenderMsMax,
          Math.round(duration * 100) / 100,
        );
      }
      const chars = Number(entryChars);
      if (Number.isFinite(chars) && chars >= 0) {
        entry.reasoningPeakEntryChars = Math.max(entry.reasoningPeakEntryChars, Math.floor(chars));
      }
    }

    // kind: 'patch' (stream-reveal/in-place article patch), 'full'
    // (performFullMessageRender), or 'noop' (signature-equal frame skipped).
    // Only counts while the session has a live tracked stream, which scopes
    // the counters to the streaming window without threading streamIds
    // through the render pipeline.
    function noteRenderForSession(sessionId, kind, reason) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return;
      }
      const streamId = streamIdBySessionId.get(normalizedSessionId);
      const entry = streamId ? byStreamId.get(streamId) : null;
      if (!entry) {
        return;
      }
      if (kind === 'noop') {
        entry.noopRenders += 1;
        return;
      }
      // Intra-patch header cost markers (chat_stream_paint_v2): a rewrite is
      // the destructive innerHTML replacement, a morph the in-place update.
      // Neither is a paint event of its own — the surrounding 'patch' already
      // counted — so they never advance firstPaintAtMs.
      if (kind === 'reasoning_header_rewrite') {
        entry.reasoningHeaderRewrites += 1;
        return;
      }
      if (kind === 'reasoning_header_morph') {
        entry.reasoningHeaderMorphs += 1;
        return;
      }
      if (kind === 'patch') {
        entry.streamRevealPatchesApplied += 1;
      } else if (kind === 'full') {
        entry.fullRenders += 1;
        const normalizedReason = normalizeId(reason);
        if (normalizedReason) {
          entry.fullRenderReasons[normalizedReason] =
            (entry.fullRenderReasons[normalizedReason] || 0) + 1;
        }
      } else {
        const unknownKind = normalizeId(kind).slice(0, MAX_RENDER_KIND_LENGTH) || '<empty>';
        if (warnedUnknownRenderKinds.size < MAX_UNKNOWN_RENDER_KIND_WARNINGS
          && !warnedUnknownRenderKinds.has(unknownKind)) {
          warnedUnknownRenderKinds.add(unknownKind);
          try {
            appendClientLog('WARN', 'stream.render_kind_unknown', { kind: unknownKind });
          } catch (_error) {
            // Logging is best-effort; never break the render path.
          }
        }
        return;
      }
      if (entry.firstPaintAtMs == null && entry.deltasReceived > 0) {
        entry.firstPaintAtMs = now();
      }
    }

    function take(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      const entry = byStreamId.get(normalizedStreamId);
      if (lastDeltaStreamId === normalizedStreamId) lastDeltaStreamId = '';
      if (!entry) {
        return null;
      }
      byStreamId.delete(normalizedStreamId);
      if (streamIdBySessionId.get(entry.sessionId) === normalizedStreamId) {
        streamIdBySessionId.delete(entry.sessionId);
      }
      const firstDeltaToFirstPaintMs = entry.firstDeltaAtMs != null && entry.firstPaintAtMs != null
        ? Math.max(entry.firstPaintAtMs - entry.firstDeltaAtMs, 0)
        : null;
      // take() runs at stream terminal, so now() here is the terminal time.
      const lastDeltaToTerminalMs = entry.lastDeltaAtMs != null
        ? Math.max(now() - entry.lastDeltaAtMs, 0)
        : null;
      return {
        deltas_received: entry.deltasReceived,
        first_delta_at_ms: entry.firstDeltaAtMs,
        first_paint_at_ms: entry.firstPaintAtMs,
        first_delta_to_first_paint_ms: firstDeltaToFirstPaintMs,
        last_delta_to_terminal_ms: lastDeltaToTerminalMs,
        stream_reveal_patches_applied: entry.streamRevealPatchesApplied,
        full_renders: entry.fullRenders,
        noop_renders: entry.noopRenders,
        reasoning_header_rewrites: entry.reasoningHeaderRewrites,
        reasoning_header_morphs: entry.reasoningHeaderMorphs,
        reasoning_body_renders: entry.reasoningBodyRenders,
        reasoning_body_full_renders: entry.reasoningBodyFullRenders,
        reasoning_body_fallback_reasons: Object.assign(
          Object.create(null),
          entry.reasoningBodyFallbackReasons,
        ),
        reasoning_body_render_ms_max: entry.reasoningBodyRenderMsMax,
        reasoning_peak_entry_chars: entry.reasoningPeakEntryChars,
        mailbox_peak_depth: entry.mailboxPeakDepth,
        mailbox_peak_queued_bytes: entry.mailboxPeakQueuedBytes,
        mailbox_dropped: entry.mailboxDropped,
        full_render_reasons: { ...entry.fullRenderReasons },
      };
    }

    // Take + fire-and-forget ship to the electron diagnostics merge endpoint.
    function reportTerminal(payload) {
      const streamId = normalizeId(payload?.streamId || payload?.stream_id);
      const sessionId = normalizeId(payload?.sessionId || payload?.session_id);
      const metrics = take(streamId);
      if (!metrics) {
        return;
      }
      const gapMs = metrics.last_delta_to_terminal_ms;
      if (gapMs != null && gapMs > TERMINAL_GAP_WARN_MS) {
        try {
          appendClientLog('WARN', 'stream.terminal_gap_slow', {
            streamId,
            sessionId,
            gapMs: Math.round(gapMs),
          });
        } catch (_error) {
          // Logging is best-effort; never break terminal handling.
        }
      }
      try {
        const result = ship({
          stream_id: streamId,
          session_id: sessionId,
          client_timing: metrics,
        });
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch (_error) {
        // Diagnostics shipping is best-effort; never break terminal handling.
      }
    }

    return Object.freeze({
      noteDelta,
      noteRenderForSession,
      noteMailbox,
      noteReasoningBodyRender,
      take,
      reportTerminal,
    });
  }

  let sharedInstance = null;
  function getShared() {
    if (!sharedInstance) {
      sharedInstance = createStreamClientMetrics();
    }
    return sharedInstance;
  }

  return Object.freeze({
    createStreamClientMetrics,
    getShared,
  });
});
