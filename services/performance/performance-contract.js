'use strict';

/* services/performance/performance-contract.js - wire shapes for the
 * performance.* bridge and the inference.performance notification (row 59
 * checkpoint 6). Closed request schemas, the `{ok, ...}` / `{ok:false, code,
 * reason}` envelope, the closed payload normalizer for sidecar observations and
 * the bounded terminal-summary record persisted on a turn's usage row. Pure: no
 * I/O, no logging. Unknown keys, malformed ids and nonfinite numbers fail
 * closed; `reason` is always a stable token, never exception prose.
 */

const { PERFORMANCE_ERROR_CODES } = require('../backend/error-codes');
const { isPlainObject, validSessionId } = require('../chat-workspace-contract');

const SCHEMA_VERSION = 1;
const MAX_TOKENS = 1_048_576;
const MAX_DURATION_MS = 86_400_000;
const MAX_RATE = 10_000_000;
const MAX_SUMMARIES = 32;
const MAX_SUMMARY_BYTES = 16 * 1024;
const WARNING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{16,64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

const PHASES = Object.freeze(['waiting', 'loading', 'prefill', 'decode', 'finished', 'failed', 'cancelled']);
const TERMINAL_PHASES = Object.freeze(['finished', 'failed', 'cancelled']);
const SOURCES = Object.freeze(['provider', 'unavailable']);
const PROVIDER_KINDS = Object.freeze(['ninfer', 'llama-server', 'ollama', 'other']);
const METRIC_STATES = Object.freeze(['available', 'warming', 'stale', 'unavailable', 'not_applicable', 'available_next_request']);

// Nullable measured fields of a notification and the range each must satisfy.
const TOKEN_FIELDS = Object.freeze([
  'generated_tokens', 'decode_interval_tokens', 'prompt_tokens', 'cached_prompt_tokens', 'processed_prompt_tokens',
]);
const DURATION_FIELDS = Object.freeze([
  'decode_elapsed_ms', 'prefill_elapsed_ms', 'time_to_first_generated_token_ms',
]);
const RATE_FIELDS = Object.freeze(['terminal_decode_tps', 'terminal_prefill_tps']);
const METRIC_FIELDS = Object.freeze([...TOKEN_FIELDS, ...DURATION_FIELDS, ...RATE_FIELDS]);

// reason -> error code. Anything unlisted degrades to `collection_unavailable`.
const REASON_CODES = Object.freeze({
  invalid_request: PERFORMANCE_ERROR_CODES.INVALID_REQUEST,
  settings_read_only: PERFORMANCE_ERROR_CODES.UNSUPPORTED_CAPABILITY,
  unsupported_capability: PERFORMANCE_ERROR_CODES.UNSUPPORTED_CAPABILITY,
  collection_unavailable: PERFORMANCE_ERROR_CODES.COLLECTION_UNAVAILABLE,
  stale_warning: PERFORMANCE_ERROR_CODES.STALE_WARNING,
});

function stableReason(reason) {
  const token = typeof reason === 'string' ? reason : '';
  return REASON_PATTERN.test(token) ? token : 'collection_unavailable';
}

function fail(reason) {
  const token = stableReason(reason);
  return { ok: false, code: REASON_CODES[token] || PERFORMANCE_ERROR_CODES.COLLECTION_UNAVAILABLE, reason: token };
}

function succeed(payload) {
  return { ok: true, ...payload };
}

function hasExactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

const invalid = Object.freeze({ ok: false, reason: 'invalid_request' });
// `session_id: null` is the host scope (health pill, Settings): settings and GPU only, no inference.
const validScope = (value) => value === null || validSessionId(value);

function validateGetSnapshotRequest(raw) {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['schema_version', 'session_id'])
    || raw.schema_version !== SCHEMA_VERSION || !validScope(raw.session_id)) return invalid;
  return { ok: true, value: { session_id: raw.session_id } };
}

// At least one strict boolean; nothing else is accepted.
function validateUpdateSettingsRequest(raw) {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['schema_version'], ['show_counter', 'gpu_warnings_enabled'])
    || raw.schema_version !== SCHEMA_VERSION) return invalid;
  const value = {};
  if (Object.hasOwn(raw, 'show_counter')) {
    if (typeof raw.show_counter !== 'boolean') return invalid;
    value.showCounter = raw.show_counter;
  }
  if (Object.hasOwn(raw, 'gpu_warnings_enabled')) {
    if (typeof raw.gpu_warnings_enabled !== 'boolean') return invalid;
    value.gpuWarningsEnabled = raw.gpu_warnings_enabled;
  }
  return Object.keys(value).length ? { ok: true, value } : invalid;
}

function validateDismissWarningRequest(raw) {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['schema_version', 'session_id', 'warning_id'])
    || raw.schema_version !== SCHEMA_VERSION || !validScope(raw.session_id)
    || typeof raw.warning_id !== 'string' || !WARNING_ID_PATTERN.test(raw.warning_id)) return invalid;
  return { ok: true, value: { session_id: raw.session_id, warning_id: raw.warning_id } };
}

function boundedInt(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

function boundedNumber(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function boundedId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

// The measured fields of one notification, each nulled when absent or out of
// range (a bad field never fails the observation as a whole).
function normalizeMetricFields(source) {
  const out = {};
  for (const field of TOKEN_FIELDS) out[field] = boundedInt(source[field], MAX_TOKENS);
  for (const field of DURATION_FIELDS) out[field] = boundedNumber(source[field], MAX_DURATION_MS);
  for (const field of RATE_FIELDS) out[field] = boundedNumber(source[field], MAX_RATE);
  return out;
}

// One `inference.performance` payload -> closed observation, or null when its
// envelope (schema, attempt, sequence, clock, phase, source, kind) is unusable.
// Request/session ownership is the intake's check against the stream context.
function normalizeObservation(params) {
  if (!isPlainObject(params) || params.schema_version !== SCHEMA_VERSION) return null;
  if (typeof params.attempt_id !== 'string' || !ATTEMPT_ID_PATTERN.test(params.attempt_id)) return null;
  if (!Number.isSafeInteger(params.sequence) || params.sequence < 0) return null;
  if (!Number.isSafeInteger(params.sampled_at) || params.sampled_at < 0) return null;
  if (!PHASES.includes(params.phase) || !SOURCES.includes(params.source)
    || !PROVIDER_KINDS.includes(params.provider_kind)) return null;
  return {
    attempt_id: params.attempt_id,
    sequence: params.sequence,
    sampled_at: params.sampled_at,
    phase: params.phase,
    source: params.source,
    provider_kind: params.provider_kind,
    turn_id: boundedId(params.turn_id),
    provider_call_id: boundedId(params.provider_call_id),
    ...normalizeMetricFields(params),
  };
}

// Persisted terminal summary: the closed subset of an observation worth keeping.
const SUMMARY_FIELDS = Object.freeze([
  'turn_id', 'provider_call_id', 'attempt_id', 'sampled_at', 'phase', 'provider_kind', ...METRIC_FIELDS,
]);

function normalizeSummary(value) {
  if (!isPlainObject(value)) return null;
  const observation = normalizeObservation({
    schema_version: SCHEMA_VERSION, sequence: 0, source: 'provider', ...value,
  });
  if (!observation || !TERMINAL_PHASES.includes(observation.phase)) return null;
  return Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, observation[field]]));
}

// `{schema_version:1, summaries:[<=32], omitted_count}` within 16 KiB serialized,
// keeping the latest summaries; anything shed is counted. Null when nothing is left.
function boundInferencePerformance(value) {
  if (!isPlainObject(value) || !Array.isArray(value.summaries)) return null;
  const known = Number.isSafeInteger(value.omitted_count) && value.omitted_count > 0 ? value.omitted_count : 0;
  const summaries = value.summaries.map(normalizeSummary);
  const kept = summaries.filter(Boolean);
  let omitted = known + (summaries.length - kept.length);
  if (kept.length > MAX_SUMMARIES) {
    omitted += kept.length - MAX_SUMMARIES;
    kept.splice(0, kept.length - MAX_SUMMARIES);
  }
  const record = () => ({ schema_version: SCHEMA_VERSION, summaries: kept, omitted_count: omitted });
  while (kept.length && Buffer.byteLength(JSON.stringify(record()), 'utf8') > MAX_SUMMARY_BYTES) {
    kept.shift();
    omitted += 1;
  }
  return kept.length ? record() : null;
}

module.exports = {
  ATTEMPT_ID_PATTERN,
  MAX_DURATION_MS,
  MAX_RATE,
  MAX_SUMMARIES,
  MAX_SUMMARY_BYTES,
  MAX_TOKENS,
  METRIC_FIELDS,
  METRIC_STATES,
  PHASES,
  PROVIDER_KINDS,
  SCHEMA_VERSION,
  SOURCES,
  TERMINAL_PHASES,
  WARNING_ID_PATTERN,
  boundInferencePerformance,
  fail,
  normalizeMetricFields,
  normalizeObservation,
  stableReason,
  succeed,
  validateDismissWarningRequest,
  validateGetSnapshotRequest,
  validateUpdateSettingsRequest,
};
