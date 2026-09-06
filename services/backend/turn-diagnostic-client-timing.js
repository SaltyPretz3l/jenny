/* services/backend/turn-diagnostic-client-timing.js - renderer client_timing
 * ingest for turn diagnostics: the short-lived pending store that holds a
 * renderer paint-counter report until its turn diagnostic dump exists, and the
 * allowlist normalizer that decides which client_timing fields reach disk. */

const CLIENT_TIMING_PENDING_LIMIT = 1024;
const CLIENT_TIMING_PENDING_TTL_MS = 2 * 60 * 1000;
const _pendingClientTiming = new Map();

function _pendingTimingKey(userDataPath, streamId) {
  return `${userDataPath}\0${streamId}`;
}

function _purgePendingClientTiming(emitLog, now = Date.now()) {
  for (const [key, entry] of _pendingClientTiming) {
    if (now - entry.storedAt <= CLIENT_TIMING_PENDING_TTL_MS) continue;
    _pendingClientTiming.delete(key);
    clearTimeout(entry.expiryTimer);
    emitLog('WARN', 'chat.turn_diagnostic_client_timing_expired', {
      streamId: entry.streamId,
    });
  }
}

function _storePendingClientTiming(
  emitLog, userDataPath, streamId, timing, { preferExisting = false } = {}
) {
  _purgePendingClientTiming(emitLog);
  const key = _pendingTimingKey(userDataPath, streamId);
  const existing = _pendingClientTiming.get(key);
  clearTimeout(existing?.expiryTimer);
  _pendingClientTiming.delete(key);
  const entry = {
    streamId,
    storedAt: Date.now(),
    timing: preferExisting
      ? { ...timing, ...(existing?.timing || {}) }
      : { ...(existing?.timing || {}), ...timing },
    expiryTimer: null,
  };
  entry.expiryTimer = setTimeout(() => {
    if (_pendingClientTiming.get(key) !== entry) return;
    _pendingClientTiming.delete(key);
    emitLog('WARN', 'chat.turn_diagnostic_client_timing_expired', {
      streamId: entry.streamId,
    });
  }, CLIENT_TIMING_PENDING_TTL_MS);
  entry.expiryTimer.unref?.();
  _pendingClientTiming.set(key, entry);
  while (_pendingClientTiming.size > CLIENT_TIMING_PENDING_LIMIT) {
    const oldestKey = _pendingClientTiming.keys().next().value;
    const evicted = _pendingClientTiming.get(oldestKey);
    _pendingClientTiming.delete(oldestKey);
    clearTimeout(evicted?.expiryTimer);
    emitLog('WARN', 'chat.turn_diagnostic_client_timing_evicted', {
      streamId: evicted?.streamId || '',
    });
  }
}

function _takePendingClientTiming(emitLog, userDataPath, streamId) {
  _purgePendingClientTiming(emitLog);
  const key = _pendingTimingKey(userDataPath, streamId);
  const entry = _pendingClientTiming.get(key);
  _pendingClientTiming.delete(key);
  clearTimeout(entry?.expiryTimer);
  return entry?.timing || null;
}

const _CLIENT_TIMING_NUMERIC_FIELDS = Object.freeze([
  // Send-phase markers captured at chat.startStream.
  'send_started_at_ms',
  'optimistic_rendered_at_ms',
  'local_render_latency_ms',
  'first_stream_event_at_ms',
  // Renderer paint counters shipped at stream terminal
  // (renderer-stream-client-metrics.js → diagnostics.reportClientStreamMetrics).
  'first_delta_at_ms',
  'first_paint_at_ms',
  'first_delta_to_first_paint_ms',
  'last_delta_to_terminal_ms',
  'deltas_received',
  'stream_reveal_patches_applied',
  'full_renders',
  'noop_renders',
  // Ht-C reasoning-header paint-min counters (chat_stream_paint_v2). take()
  // ships these; the allowlist must include them or they are silently dropped.
  'reasoning_header_rewrites',
  'reasoning_header_morphs',
  'reasoning_body_renders',
  'reasoning_body_full_renders',
  'reasoning_body_render_ms_max',
  'reasoning_peak_entry_chars',
  // Stream-mailbox queue peaks shipped by renderer-stream-client-metrics.js.
  'mailbox_peak_depth',
  'mailbox_peak_queued_bytes',
  'mailbox_dropped',
]);

// The three send-phase markers reach this serializer in camelCase when they come
// from normalizePhaseClientTiming() (the JS-runtime percentiles-aggregator shape
// managed-sidecar-chat.js feeds into dumpTurnDiagnostic), but the on-disk
// client_timing is snake_case and the renderer's own paint-counter payload is
// already snake_case. Accept either casing at ingest and always emit snake_case,
// so an initial dump carrying the aggregator shape is not silently null.
const _CLIENT_TIMING_CAMEL_ALIASES = Object.freeze({
  send_started_at_ms: 'sendStartedAtMs',
  optimistic_rendered_at_ms: 'optimisticRenderedAtMs',
  local_render_latency_ms: 'localRenderLatencyMs',
});

// The renderer ships bounded {reason: count} histograms next to full-render
// counters (renderer-stream-client-metrics.js). Without them a degraded dump
// says THAT paints went wide but never WHY. Bounded: ≤32 reasons, key ≤64 chars.
const _FULL_RENDER_REASONS_MAX_KEYS = 32;
const _FULL_RENDER_REASONS_MAX_KEY_LENGTH = 64;

function _normalizeFullRenderReasons(reasons) {
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) return null;
  const out = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(reasons)) {
    if (kept >= _FULL_RENDER_REASONS_MAX_KEYS) break;
    const count = Number(raw);
    const name = String(key || '').trim().slice(0, _FULL_RENDER_REASONS_MAX_KEY_LENGTH);
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    out[name] = Math.floor(count);
    kept += 1;
  }
  return kept === 0 ? null : out;
}

function _normalizeClientTiming(clientTiming) {
  if (!clientTiming || typeof clientTiming !== 'object') return null;
  const out = {};
  for (const field of _CLIENT_TIMING_NUMERIC_FIELDS) {
    let value = Number(clientTiming[field]);
    const alias = _CLIENT_TIMING_CAMEL_ALIASES[field];
    if (!Number.isFinite(value) && alias !== undefined) {
      value = Number(clientTiming[alias]);
    }
    if (Number.isFinite(value)) out[field] = value;
  }
  const reasons = _normalizeFullRenderReasons(
    clientTiming.full_render_reasons ?? clientTiming.fullRenderReasons,
  );
  if (reasons) out.full_render_reasons = reasons;
  const reasoningReasons = _normalizeFullRenderReasons(
    clientTiming.reasoning_body_fallback_reasons ?? clientTiming.reasoningBodyFallbackReasons,
  );
  if (reasoningReasons) out.reasoning_body_fallback_reasons = reasoningReasons;
  return Object.keys(out).length === 0 ? null : out;
}

module.exports = {
  CLIENT_TIMING_PENDING_LIMIT,
  CLIENT_TIMING_PENDING_TTL_MS,
  storePendingClientTiming: _storePendingClientTiming,
  takePendingClientTiming: _takePendingClientTiming,
  normalizeClientTiming: _normalizeClientTiming,
};
