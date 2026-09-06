/*
 * Pure helpers for the v2 reasoning-row renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.reasoningRowV2Utils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const REASONING_STATUS_VALUES = Object.freeze([
    'streaming',
    'complete',
    'error',
    'empty',
  ]);
  const SETTLED_MESSAGE_STATUSES = new Set(['complete', 'completed', 'done', 'cancelled', 'canceled', 'aborted']);

  function normalizeReasoningStatus(value) {
    const candidate = String(value || '').trim().toLowerCase();
    if (!candidate) return 'empty';
    return candidate;
  }

  function normalizeMessageStatus(value) {
    return String(value || '').trim().toLowerCase();
  }

  function hasReasoningEntries(entries) {
    return Array.isArray(entries) && entries.length > 0;
  }

  function reasoningStatusTone(status, { isStreaming = false } = {}) {
    if (isStreaming) return 'active';
    switch (normalizeReasoningStatus(status)) {
      case 'streaming': return 'active';
      case 'complete': return 'ok';
      case 'error': return 'error';
      case 'empty': return 'muted';
      default: return 'muted';
    }
  }

  function shouldAutoExpandReasoningV2(status, { isStreaming = false } = {}) {
    if (isStreaming) return true;
    /* Settled reasoning, including errors, collapses because the error card owns the failure story;
       stored user expansion still overrides the default. */
    return normalizeReasoningStatus(status) === 'streaming';
  }

  function formatReasoningSecondaryMeta({ tokensPerSecond = null } = {}) {
    const tokRate = Number(tokensPerSecond);
    if (!Number.isFinite(tokRate) || tokRate <= 0) return '';
    const rounded = tokRate >= 10 ? Math.round(tokRate) : Math.round(tokRate * 10) / 10;
    return `${rounded} tok/s`;
  }

  // Ollama-style "Thought for Xs" duration. Returns '' while still streaming, on
  // a not-yet-completed phase, or when either timestamp is missing/unparseable
  // or the span is non-positive — so the caller only ever shows a real, settled
  // duration. B3: sub-second spans return '' (no badge) — a "Thought for <1s" chip
  // on every near-instant phase-start is low-signal noise; longer spans mirror
  // formatDurationMs's one-decimal seconds form.
  function formatReasoningDuration(startedAt, completedAt, { isStreaming = false, completed = false } = {}) {
    if (isStreaming || !completed) return '';
    const start = Date.parse(startedAt);
    const end = Date.parse(completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
    const durationMs = end - start;
    if (durationMs < 1000) return '';
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  /* Trailing close-quotes / brackets that may follow a sentence terminator. */
  const TRAILING_CLOSERS = '[)\\]"\'’”»]';
  /* A “meaningful” preview must contain at least one word character; otherwise
   * we fall back to the raw tail so the header never displays a lone `"`. */
  const MEANINGFUL_PREVIEW_RE = /\p{L}|\p{N}/u;

  function buildReasoningPreview(entries, { charLimit = 140 } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return '';
    const joined = list
      .map((entry) => String(entry?.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!joined) return '';
    if (joined.length <= charLimit) return joined;
    const tailWindow = joined.slice(-Math.max(charLimit, 80));
    const sentenceRe = new RegExp(`[^.!?\\n]+[.!?\\n]+${TRAILING_CLOSERS}*\\s*$`, 'u');
    const sentenceMatch = tailWindow.match(sentenceRe);
    let candidate = sentenceMatch ? sentenceMatch[0].trim() : tailWindow.trim();
    if (!MEANINGFUL_PREVIEW_RE.test(candidate)) {
      candidate = tailWindow.trim();
    }
    return candidate.length > charLimit ? `${candidate.slice(-(charLimit - 1))}…` : candidate;
  }

  function deriveReasoningStatus(message, { isStreamingTail = false, phaseCompleted = false } = {}) {
    const messageStatus = normalizeMessageStatus(message?.status);
    const entries = message?.reasoning?.entries;
    const explicit = normalizeReasoningStatus(message?.reasoning?.status);
    if (messageStatus === 'error') {
      return 'error';
    }
    if (phaseCompleted === true) {
      return 'complete';
    }
    if (
      SETTLED_MESSAGE_STATUSES.has(messageStatus)
      && explicit === 'streaming'
    ) {
      return hasReasoningEntries(entries) ? 'complete' : 'empty';
    }
    if (REASONING_STATUS_VALUES.includes(explicit) && explicit !== 'empty') {
      return explicit;
    }
    if (isStreamingTail) return 'streaming';
    return hasReasoningEntries(entries) ? 'complete' : 'empty';
  }

  // Live window (long-thinking perf, S5): while a phase streams past
  // LIVE_WINDOW_CHARS of rendered html, only the trailing LIVE_WINDOW_CHARS of
  // units keep their markup. Earlier units are emitted as EMPTY placeholders
  // under a fixed fingerprint so unit indices stay stable (the in-place
  // reconcile keys on index and compares fingerprints), which turns every
  // elided unit into one attribute compare per frame instead of an HTML parse
  // plus a live DOM subtree. The start only moves forward for a phase (callers
  // thread the previous start back in), so a tail re-chunk or a source
  // retraction never re-materialises earlier units mid-stream. The settled
  // (non-streaming) render never elides, so the full body appears when the
  // step completes.
  const LIVE_WINDOW_CHARS = 32 * 1024;
  const LIVE_WINDOW_ELIDED_FINGERPRINT = 'elided';
  const LIVE_WINDOW_NOTE_FINGERPRINT = 'elided-note';
  const LIVE_WINDOW_NOTE_HTML = '<p class="reasoning-row-meta reasoning-live-window-note">Earlier thinking will show when this step completes.</p>';

  function resolveLiveWindowStart(units, previousStart, options) {
    const list = Array.isArray(units) ? units : [];
    const windowChars = Number(options?.windowChars) > 0 ? Number(options.windowChars) : LIVE_WINDOW_CHARS;
    const lengthOf = (unit) => String(unit?.html || '').length;
    // A re-chunk to fewer units than the previous start invalidates the
    // start's index mapping, so the floor resets instead of pinning the window
    // to the tail for the rest of the phase.
    const previous = Math.max(0, Math.floor(Number(previousStart) || 0));
    const floor = previous < list.length ? previous : 0;
    let total = 0;
    for (const unit of list) total += lengthOf(unit);
    if (total <= windowChars) return floor;
    let start = list.length;
    let kept = 0;
    while (start > 0 && kept + lengthOf(list[start - 1]) <= windowChars) {
      kept += lengthOf(list[start - 1]);
      start -= 1;
    }
    // The tail unit is always live, even when it alone exceeds the window.
    if (start === list.length) start = list.length - 1;
    return Math.max(start, floor);
  }

  return {
    REASONING_STATUS_VALUES,
    LIVE_WINDOW_CHARS,
    LIVE_WINDOW_ELIDED_FINGERPRINT,
    LIVE_WINDOW_NOTE_FINGERPRINT,
    LIVE_WINDOW_NOTE_HTML,
    resolveLiveWindowStart,
    normalizeReasoningStatus,
    reasoningStatusTone,
    shouldAutoExpandReasoningV2,
    formatReasoningSecondaryMeta,
    formatReasoningDuration,
    buildReasoningPreview,
    deriveReasoningStatus,
  };
});
