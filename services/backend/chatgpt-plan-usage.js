'use strict';

// Pure normalizer for the ChatGPT plan-usage snapshot that rides
// chat.done.params.usage.plan_usage / chat.error.params.plan_usage (see
// docs/plans "ChatGPT plan-usage meter" W2). No I/O here -- this module only
// validates and reshapes the wire payload key-by-key so a foreign/older
// sidecar, a malformed header value, or an out-of-range field can never reach
// the persisted record or the renderer. Every function is pure; callers own
// disk access, the account-key hash, and the clock.

const PLAN_USAGE_SCHEMA_VERSION = 1;
const RATE_LIMIT_REACHED_TYPES = new Set(['primary', 'secondary']);
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 1_051_200; // 2 years in minutes -- generous upper bound, not a real plan window.
const MIN_RESET_AT_SECONDS = 1_000_000_000; // 2001-09-09 -- rejects an obviously-wrong unit (e.g. ms mistaken for s).
const MAX_RESET_AT_SECONDS = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER -- rejects overflow/garbage.
const PLAN_USAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Every coercion below requires an actual JS `number` typeof, not a generic
// Number(value) coercion: the wire payload is already-parsed JSON, so a
// genuine numeric field arrives as a real number, and refusing to coerce
// strings/arrays/booleans/objects closes JS's Number() coercion quirks (e.g.
// Number([]) === 0, Number([1500000000]) === 1500000000) that would otherwise
// let a malformed value sneak through as a plausible-looking reading.
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeUsedPercent(value) {
  if (!isFiniteNumber(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

function normalizeWindowMinutes(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < MIN_WINDOW_MINUTES || value > MAX_WINDOW_MINUTES) {
    return undefined;
  }
  return value;
}

function normalizeResetAt(value) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < MIN_RESET_AT_SECONDS || value > MAX_RESET_AT_SECONDS) {
    return null;
  }
  return value;
}

// Normalizes one window (`primary` or `secondary`). Returns null when the
// window is missing/malformed/absent -- used_percent and reset_at are both
// required for a window to be usable; window_minutes is optional and simply
// omitted from the output when it fails its own range check (the window
// itself stays valid).
function normalizeWindow(rawWindow) {
  if (!isPlainObject(rawWindow)) {
    return null;
  }
  const usedPercent = normalizeUsedPercent(rawWindow.used_percent);
  if (usedPercent === null) {
    return null;
  }
  const resetAt = normalizeResetAt(rawWindow.reset_at);
  if (resetAt === null) {
    return null;
  }
  const windowMinutes = normalizeWindowMinutes(rawWindow.window_minutes);
  const normalized = {
    used_percent: usedPercent,
    reset_at: resetAt,
  };
  if (windowMinutes !== undefined) {
    normalized.window_minutes = windowMinutes;
  }
  return normalized;
}

function normalizeRateLimitReachedType(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  return RATE_LIMIT_REACHED_TYPES.has(token) ? token : undefined;
}

// normalizePlanUsageSnapshot(input) -> normalized snapshot object or null.
// Never spreads `input`: every output key is assigned explicitly, so an
// unexpected/injected key on the wire payload (e.g. `evil`) can never survive
// into the normalized shape or the persisted record built from it.
function normalizePlanUsageSnapshot(input) {
  if (!isPlainObject(input)) {
    return null;
  }
  if (input.schema_version !== PLAN_USAGE_SCHEMA_VERSION) {
    return null;
  }
  const primary = normalizeWindow(input.primary);
  const secondary = normalizeWindow(input.secondary);
  if (!primary && !secondary) {
    return null;
  }
  const normalized = { schema_version: PLAN_USAGE_SCHEMA_VERSION };
  if (primary) {
    normalized.primary = primary;
  }
  if (secondary) {
    normalized.secondary = secondary;
  }
  const rateLimitReachedType = normalizeRateLimitReachedType(input.rate_limit_reached_type);
  if (rateLimitReachedType !== undefined) {
    normalized.rate_limit_reached_type = rateLimitReachedType;
  }
  return normalized;
}

// buildPlanUsageRecord(snapshot, opts) -> the persisted-record shape written
// to <userData>/chatgpt-plan-usage.json. `snapshot` must already be the
// output of normalizePlanUsageSnapshot (non-null); this function does not
// re-validate window contents, only reshapes + stamps ownership/provenance.
function buildPlanUsageRecord(snapshot, { accountKey, source, now = Date.now } = {}) {
  const record = {
    version: 1,
    account_key: String(accountKey || ''),
    primary: snapshot?.primary || null,
    captured_at_ms: typeof now === 'function' ? now() : Number(now),
    source: source === 'chat_error' ? 'chat_error' : 'chat_done',
  };
  if (snapshot?.secondary) {
    record.secondary = snapshot.secondary;
  }
  if (snapshot?.rate_limit_reached_type) {
    record.rate_limit_reached_type = snapshot.rate_limit_reached_type;
  }
  return record;
}

module.exports = {
  PLAN_USAGE_SCHEMA_VERSION,
  PLAN_USAGE_MAX_AGE_MS,
  normalizePlanUsageSnapshot,
  buildPlanUsageRecord,
};
