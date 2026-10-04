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
  // Row-list morph cost counters (timeline-perf 2026-09-30): how often the
  // keyed fallback rebuilt a row-model turn's rows and how many rows it cost.
  'row_list_morphs',
  'row_list_rows_reused',
  'row_list_rows_rebuilt',
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

// Fixed producer vocabulary from the render ladder, stream-reveal patch
// targets and markdown-stream-renderer. Composite row-list reasons use only
// these fixed components; caller-supplied keys never become persisted keys.
const _REASONING_PATCH_REASONS = Object.freeze([
  'no_stack', 'stack_new_no_bubble', 'stack_removed', 'blocks_unresolved',
  'duplicate_block_key', 'block_unaligned', 'sibling_duplicate_key',
  'sibling_missing', 'sibling_status_mismatch', 'sibling_fp_mismatch',
  'block_count_mismatch', 'block_key_mismatch', 'block_shape_mismatch',
]);
const _ROW_LIST_REASONS = Object.freeze([
  'not_surgical', 'article_rewrite', 'no_reasoning_stack', 'answer_row_open', 'no_anchor',
  ..._REASONING_PATCH_REASONS,
  ...['bubble', 'anchor', 'bubble_idle'].flatMap((prefix) =>
    [..._REASONING_PATCH_REASONS, 'no_reasoning_stack'].map((reason) => `${prefix}:${reason}`)),
]);
const _CLIENT_TIMING_REASONS = Object.freeze([
  'force', 'projection_revision', 'recap_expansion', 'thread_expansion',
  'final_full_render', 'unclassified', 'missing_streaming_article', 'streaming_article_rewrite_refused',
  ...['tail_not_eligible', 'tail_error', 'tail_settled', 'no_assistant'].map((reason) => `no_live_stream:${reason}`),
  ...['no_timeline', 'session_mismatch', 'signature_mismatch', 'streaming_id_mismatch'].map((reason) => `cannot_patch:${reason}`),
  'patch_fallback',
  ...['no_article', 'reasoning_structural', 'row_model_morph_failed', 'row_model_no_row_list_markup']
    .map((reason) => `patch_fallback:${reason}`),
  'initial', 'invalid_state', 'source_replaced', 'guard_unavailable', 'render_unavailable', 'no_stable_prefix',
  ..._ROW_LIST_REASONS,
  ...['helper_unavailable', 'scope_not_reasoning_row', 'scope_names_other_segment',
    'segment_row_not_rendered', 'segment_row_state_mismatch', 'scope_stack_missing']
    .flatMap((live) => _ROW_LIST_REASONS.map((reason) => `live:${live}>${reason}`)),
  'other',
]);
const _CLIENT_TIMING_REASON_KEYS = new Set(_CLIENT_TIMING_REASONS);
const _FULL_RENDER_REASONS_MAX_KEYS = 32;

function _normalizeFullRenderReasons(reasons) {
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(reasons)) {
    const count = Number(raw);
    if (!Number.isFinite(count) || count < 1) continue;
    let name = _CLIENT_TIMING_REASON_KEYS.has(key) ? key : 'other';
    // Reserve one bucket for unknown keys and overflow, preserving counts.
    if (!Object.hasOwn(out, name) && name !== 'other'
      && Object.keys(out).filter((reason) => reason !== 'other').length >= _FULL_RENDER_REASONS_MAX_KEYS - 1) {
      name = 'other';
    }
    out[name] = Math.min((out[name] || 0) + Math.floor(count), Number.MAX_SAFE_INTEGER);
  }
  return Object.keys(out).length === 0 ? null : out;
}

// null/'' are "not measured": Number(null) === 0 once wrote 0 for all three
// send-phase markers into every diagnostic. An epoch marker of 0 is no time either.
function _clientTimingNumber(field, raw) {
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN);
  if (!Number.isFinite(value)) return null;
  return field.endsWith('_at_ms') && value <= 0 ? null : value;
}

function _normalizeClientTiming(clientTiming) {
  if (!clientTiming || typeof clientTiming !== 'object') return null;
  const out = {};
  for (const field of _CLIENT_TIMING_NUMERIC_FIELDS) {
    let value = _clientTimingNumber(field, clientTiming[field]);
    const alias = _CLIENT_TIMING_CAMEL_ALIASES[field];
    if (value == null && alias !== undefined) {
      value = _clientTimingNumber(field, clientTiming[alias]);
    }
    if (value != null) out[field] = value;
  }
  const reasons = _normalizeFullRenderReasons(
    clientTiming.full_render_reasons ?? clientTiming.fullRenderReasons,
  );
  if (reasons) out.full_render_reasons = reasons;
  const reasoningReasons = _normalizeFullRenderReasons(
    clientTiming.reasoning_body_fallback_reasons ?? clientTiming.reasoningBodyFallbackReasons,
  );
  if (reasoningReasons) out.reasoning_body_fallback_reasons = reasoningReasons;
  const rowListReasons = _normalizeFullRenderReasons(
    clientTiming.row_list_morph_reasons ?? clientTiming.rowListMorphReasons,
  );
  if (rowListReasons) out.row_list_morph_reasons = rowListReasons;
  return Object.keys(out).length === 0 ? null : out;
}

module.exports = {
  CLIENT_TIMING_PENDING_LIMIT,
  CLIENT_TIMING_PENDING_TTL_MS,
  storePendingClientTiming: _storePendingClientTiming,
  takePendingClientTiming: _takePendingClientTiming,
  normalizeClientTiming: _normalizeClientTiming,
};
