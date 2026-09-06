'use strict';

const {
  IDENTIFIER_SPEC,
  normalizeIdentifier,
  sanitizeStructure,
  truncateUtf8,
  utf8Bytes,
} = require('./generated-chat-lifecycle-contract');

const CANONICAL_TURN_SCHEMA_VERSION = 1;

const EVENT_CAPS = Object.freeze({
  id: IDENTIFIER_SPEC.max_utf8_bytes,
  type: 64,
  summary: 240,
  approval_reason: 2048,
  status_text: 1000,
  text_delta: 8192,
  reasoning_delta: 4096,
  tool_input_summary: 8192,
  tool_output_summary: 16384,
  event_payload_bytes: 32768,
});

const FIELD_CAPS = [
  ['summary', EVENT_CAPS.summary],
  ['tool_name', EVENT_CAPS.summary],
  ['policy_scope', 120],
  ['policy_consequence', 120],
  ['reason', EVENT_CAPS.approval_reason],
  ['status_text', EVENT_CAPS.status_text],
  ['message', EVENT_CAPS.status_text],
  ['tool_input_summary', EVENT_CAPS.tool_input_summary],
  ['arguments_delta', EVENT_CAPS.tool_input_summary],
  ['tool_output_summary', EVENT_CAPS.tool_output_summary],
  ['output_summary', EVENT_CAPS.tool_output_summary],
];

// Display-only fields get a visible truncation marker inside the byte cap.
// The fields named here stay unmarked: delta/text chunks concatenate (or
// round-trip) downstream and an injected marker would corrupt the
// reassembled content. Mirrored by sidecar/ai/routing/turn_event_contract.py;
// keep in sync.
const MARKERLESS_FIELDS = new Set(['delta', 'text', 'arguments_delta']);
const TRUNCATION_MARKER = '…';
const TRUNCATION_MARKER_BYTES = utf8Bytes(TRUNCATION_MARKER);

const CANONICAL_TURN_COUNTER_FIELDS = Object.freeze([
  'canonical_events_emitted',
  'legacy_notifications_emitted',
  'canonical_event_bytes',
  'legacy_notification_bytes',
  'sidecar_notification_to_electron_ms',
  'electron_ingest_to_renderer_commit_ms',
  'orphan_tool_repair_count',
  'live_replay_divergence_count',
  'unknown_or_dropped_canonical_event_count',
]);

const DURABLE_EVENT_TYPES = new Set([
  'turn_started',
  'text_part_completed',
  'reasoning_part_completed',
  'tool_call_requested',
  'tool_execution_started',
  'tool_execution_completed',
  'tool_execution_failed',
  'tool_approval_requested',
  'tool_approval_resolved',
  'status_part',
  'turn_completed',
  'turn_failed',
  'turn_cancelled',
]);

const EPHEMERAL_EVENT_TYPES = new Set([
  'text_part_started',
  'text_delta',
  'reasoning_part_started',
  'reasoning_delta',
  'tool_input_started',
  'tool_input_delta',
  'tool_input_ended',
  'tool_execution_progress',
]);

const CANONICAL_EVENT_TYPES = new Set([
  ...DURABLE_EVENT_TYPES,
  ...EPHEMERAL_EVENT_TYPES,
]);

const PART_KIND_BY_TYPE = Object.freeze({
  text_part_started: 'text_part',
  text_delta: 'text_part',
  text_part_completed: 'text_part',
  reasoning_part_started: 'reasoning_part',
  reasoning_delta: 'reasoning_part',
  reasoning_part_completed: 'reasoning_part',
  tool_input_started: 'tool_part',
  tool_input_delta: 'tool_part',
  tool_input_ended: 'tool_part',
  tool_call_requested: 'tool_part',
  tool_execution_started: 'tool_part',
  tool_execution_progress: 'tool_part',
  tool_execution_completed: 'tool_part',
  tool_execution_failed: 'tool_part',
  tool_approval_requested: 'tool_part',
  tool_approval_resolved: 'tool_part',
  status_part: 'status_part',
  turn_failed: 'status_part',
  turn_cancelled: 'status_part',
});

const PERSISTED_KIND_BY_TYPE = Object.freeze({
  text_part_completed: 'assistant_text_segment',
  reasoning_part_completed: 'reasoning_phase',
  tool_call_requested: 'tool_use',
  tool_execution_started: 'tool_executing',
  tool_execution_completed: 'tool_result',
  tool_execution_failed: 'tool_result',
  tool_approval_requested: 'approval_requested',
  tool_approval_resolved: 'approval_resolved',
  turn_failed: 'assistant_error',
  turn_cancelled: 'assistant_error',
});

// Durable types that deliberately produce NO persisted timeline row. Every
// DURABLE_EVENT_TYPES member must appear either here or in
// PERSISTED_KIND_BY_TYPE — the contract tests enforce the partition.
const UNPERSISTED_DURABLE_TYPES = Object.freeze(new Set([
  // Turn boundary metadata rides the finalized turn envelope; a row would duplicate it.
  'turn_started',
  'turn_completed',
  // Transient status lines never persist; rehydrate has no timeline row to render for them.
  'status_part',
]));

const DROPPED_KEYS = new Set([
  'diagnostics',
  'provider_metadata',
  'providermetadata',
  'raw_provider_metadata',
  'rawprovidermetadata',
  'prompt',
  'system_prompt',
  'systemprompt',
  'raw_prompt',
  'rawprompt',
]);

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|credential)/i;
const DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;
// Path redaction, ported from the tool-loop rules fixed in 224aa0c6
// (services/backend/tool-loop-input-sanitization.js): the drive-letter rule was
// the only deliberate catch here, so bare POSIX paths rode verbatim into
// persisted turn events on macOS/Linux, while file:// and http(s) URLs were
// mangled by accident (the unguarded rule read the "e:/" inside "file:/").
// Order matters — file URL, drive letter, then POSIX at a delimiter. Quotes
// sit in the delimiter class so JSON-quoted POSIX values match their Windows
// twins. Unlike the tool-loop rules, the POSIX rules here are ROOT-ANCHORED
// (telemetry.py / runtime_gap.py precedent): this sanitizer runs over EVERY
// payload string including assistant text/reasoning deltas, where an
// unanchored rule mangles ordinary code and prose (app.get('/api/users'),
// "GET /api/users") into [redacted:path]. Host filesystem roots are the
// privacy payload; route-shaped slash strings are content.
// Lookbehind rather than \b, whose Unicode semantics differ across the two
// runtimes; these mirrors must stay byte-identical. Behavior table:
// tests/fixtures/canonical-turn-events/cases.json.
// Mirrored by sidecar/ai/routing/turn_event_contract.py; keep in sync.
const WINDOWS_PATH_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'<>|]+/g;
const FILE_URL_RE = /(?<![A-Za-z0-9_])file:\/\/[^\s"'<>|]+/gi;
const UNIX_PATH_RE = /(^|[\s(])\/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)(?:\/[^\s"'<>|]+|(?=$|[\s)"'<>|,]))/g;
const UNIX_PATH_AFTER_DELIMITER_RE = /(["':=,])\/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)(?:\/[^\s"'<>|]+|(?=$|[\s)"'<>|,]))/g;
const SECRET_VALUE_RE = /\b(?:sk|pk|tok|ghp|gho)_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{8,}/g;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToken(value, { limit = EVENT_CAPS.id, lower = false } = {}) {
  const text = typeof value === 'string'
    ? value.split(/\s+/).filter(Boolean).join(' ')
    : '';
  const normalized = lower ? text.toLowerCase() : text;
  return truncateUtf8(normalized, Math.max(Number(limit) || 0, 0));
}

function normalizeId(value) {
  const result = normalizeIdentifier(value);
  return result.ok ? result.value : '';
}

// CTL-015: "positive integer" must mean the same thing here and in the Python
// twin (turn_event_contract.py _coerce_seq/_coerce_version): a non-boolean
// number, finite, integral, within [1, 2^53-1]. Strings ("42", "1junk"),
// booleans, fractional and non-finite values are all malformed input — the
// shared fixture table in tests/fixtures/canonical-turn-events/cases.json
// pins the verdicts for both runtimes.
const MAX_CANONICAL_INT = Number.MAX_SAFE_INTEGER;

function coerceCanonicalInt(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return Math.abs(value) <= MAX_CANONICAL_INT ? value : null;
}

function coerceSeq(value) {
  const seq = coerceCanonicalInt(value);
  return seq !== null && seq >= 1 ? seq : null;
}

function coerceVersion(value) {
  return coerceCanonicalInt(value);
}

function nowIso() {
  return new Date().toISOString();
}

function diagnostic(code, fields = {}) {
  const result = { code: normalizeToken(code, { limit: 64, lower: true }) };
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (typeof value === 'string') {
      result[key] = normalizeToken(value, { limit: 240 });
    } else if (
      typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      result[key] = value;
    }
  }
  return result;
}

function sanitizeString(value) {
  return String(value || '')
    .replace(DATA_URI_RE, '[redacted:data-uri]')
    .replace(FILE_URL_RE, (match) => {
      const remainder = match.slice('file://'.length);
      const segments = remainder.split('/').filter(Boolean);
      if (segments.length && (/^[A-Za-z]:$/.test(segments[0]) || !remainder.startsWith('/'))) {
        segments.shift();
      }
      if (segments.length <= 1) return 'file:///[redacted:path]';
      const trailingSeparator = match.endsWith('/') ? '/' : '';
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `file:///[redacted:path]/${finalSegment}${trailingSeparator}`;
    })
    .replace(WINDOWS_PATH_RE, (match) => {
      const trailingSeparator = /[\\/]$/.test(match) ? match.at(-1) : '';
      const path = trailingSeparator ? match.slice(0, -1) : match;
      const segments = path.slice(3).split(/[\\/]/).filter(Boolean);
      if (segments.length <= 1) return '[redacted:path]';
      const separator = path[Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))];
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `[redacted:path]${separator}${finalSegment}${trailingSeparator}`;
    })
    .replace(UNIX_PATH_RE, (match, prefix) => {
      const path = match.slice(prefix.length);
      const trailingSeparator = path.endsWith('/') && path.length > 1 ? '/' : '';
      const segments = path.split('/').filter(Boolean);
      if (segments.length <= 1) return `${prefix}[redacted:path]`;
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `${prefix}[redacted:path]/${finalSegment}${trailingSeparator}`;
    })
    .replace(UNIX_PATH_AFTER_DELIMITER_RE, (match, prefix) => {
      const path = match.slice(prefix.length);
      const trailingSeparator = path.endsWith('/') && path.length > 1 ? '/' : '';
      const segments = path.split('/').filter(Boolean);
      if (segments.length <= 1) return `${prefix}[redacted:path]`;
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `${prefix}[redacted:path]/${finalSegment}${trailingSeparator}`;
    })
    .replace(SECRET_VALUE_RE, '[redacted:secret]');
}

function redactPayloadKey(key) {
  const normalizedKey = normalizeToken(key, { limit: 80, lower: true }).replaceAll('-', '_');
  const compactKey = normalizedKey.replaceAll('_', '');
  if (DROPPED_KEYS.has(compactKey)) return '[redacted]';
  return SECRET_KEY_RE.test(normalizedKey) ? '[redacted:secret]' : null;
}

function capStringField(payload, key, limit, diagnostics) {
  const value = payload[key];
  if (typeof value !== 'string' || utf8Bytes(value) <= limit) {
    return;
  }
  const withMarker = !MARKERLESS_FIELDS.has(key) && limit > TRUNCATION_MARKER_BYTES;
  payload[key] = withMarker
    ? `${truncateUtf8(value, limit - TRUNCATION_MARKER_BYTES)}${TRUNCATION_MARKER}`
    : truncateUtf8(value, limit);
  diagnostics.push(diagnostic('payload_truncated', { field: key, limit }));
}

function stableJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_error) {
    return EVENT_CAPS.event_payload_bytes + 1;
  }
}

function capPayload(eventType, payload) {
  const diagnostics = [];
  const sanitizedResult = sanitizeStructure(isPlainObject(payload) ? payload : {}, {
    sanitizeString,
    redactKey: redactPayloadKey,
  });
  let sanitized = sanitizedResult.value;
  if (sanitizedResult.reason) {
    diagnostics.push(diagnostic('structure_budget_exceeded', {
      reason: sanitizedResult.reason,
    }));
  }
  if (!isPlainObject(sanitized)) {
    sanitized = {};
  }

  if (eventType === 'text_delta') {
    capStringField(sanitized, 'delta', EVENT_CAPS.text_delta, diagnostics);
  }
  if (eventType === 'reasoning_delta' || eventType === 'reasoning_part_completed') {
    capStringField(sanitized, 'delta', EVENT_CAPS.reasoning_delta, diagnostics);
    capStringField(sanitized, 'text', EVENT_CAPS.reasoning_delta, diagnostics);
  }
  for (const [key, limit] of FIELD_CAPS) {
    capStringField(sanitized, key, limit, diagnostics);
  }

  if (stableJsonBytes(sanitized) > EVENT_CAPS.event_payload_bytes) {
    diagnostics.push(diagnostic('event_payload_truncated', {
      limit: EVENT_CAPS.event_payload_bytes,
    }));
    sanitized = {
      truncated: true,
      summary: '[truncated:event-payload]',
    };
  }
  return { payload: sanitized, diagnostics };
}

function durabilityFor(eventType, payload) {
  if (eventType === 'reasoning_part_completed' && payload?.persist === false) {
    return 'ephemeral';
  }
  return DURABLE_EVENT_TYPES.has(eventType) ? 'durable' : 'ephemeral';
}

function partKindFor(eventType) {
  return PART_KIND_BY_TYPE[eventType] || '';
}

function partIdFor(turnId, eventType, seq, provided) {
  const explicit = normalizeId(provided);
  if (explicit) {
    return explicit;
  }
  const partKind = partKindFor(eventType);
  return partKind ? `${turnId}:${partKind}:${seq}` : '';
}

function attachOptionalEnvelopeIds(event, source = {}) {
  const normalizedStreamId = normalizeId(source.stream_id || source.streamId);
  const normalizedSessionId = normalizeId(source.session_id || source.sessionId);
  const normalizedToolCallId = normalizeId(source.tool_call_id || source.toolCallId);
  if (normalizedStreamId) event.stream_id = normalizedStreamId;
  if (normalizedSessionId) event.session_id = normalizedSessionId;
  if (normalizedToolCallId) event.tool_call_id = normalizedToolCallId;
  return event;
}

function buildCanonicalTurnEvent({
  type,
  event_type,
  turn_id,
  turnId,
  seq,
  sequence,
  payload = {},
  stream_id = '',
  streamId = '',
  session_id = '',
  sessionId = '',
  event_id = '',
  eventId = '',
  part_id = '',
  partId = '',
  tool_call_id = '',
  toolCallId = '',
  ts = '',
} = {}) {
  const eventType = normalizeToken(type || event_type, {
    limit: EVENT_CAPS.type,
    lower: true,
  });
  const normalizedTurnId = normalizeId(turn_id || turnId);
  const normalizedSeq = coerceSeq(seq || sequence) || 1;
  const capped = capPayload(eventType, payload);
  const event = {
    v: CANONICAL_TURN_SCHEMA_VERSION,
    turn_id: normalizedTurnId,
    seq: normalizedSeq,
    type: eventType,
    event_id: normalizeId(event_id || eventId) || `${normalizedTurnId}:canonical:${normalizedSeq}`,
    part_id: partIdFor(normalizedTurnId, eventType, normalizedSeq, part_id || partId),
    durability: durabilityFor(eventType, capped.payload),
    payload: capped.payload,
    ts: normalizeToken(ts, { limit: 64 }) || nowIso(),
  };
  return attachOptionalEnvelopeIds(event, {
    stream_id,
    streamId,
    session_id,
    sessionId,
    tool_call_id,
    toolCallId,
  });
}

function validateTurnEvent(value) {
  if (!isPlainObject(value)) {
    return {
      status: 'dropped',
      event: null,
      diagnostics: [diagnostic('event_not_object')],
    };
  }
  const version = coerceVersion(value.v);
  if (version !== CANONICAL_TURN_SCHEMA_VERSION) {
    return {
      status: 'unsupported',
      event: null,
      diagnostics: [diagnostic('unsupported_version', {
        version: version == null ? -1 : version,
      })],
    };
  }
  const turnId = normalizeId(value.turn_id || value.turnId);
  if (!turnId) {
    return {
      status: 'dropped',
      event: null,
      diagnostics: [diagnostic('missing_turn_id')],
    };
  }
  const seq = coerceSeq(value.seq || value.sequence);
  if (seq == null) {
    return {
      status: 'dropped',
      event: null,
      diagnostics: [diagnostic('invalid_seq')],
    };
  }
  const eventType = normalizeToken(value.type || value.event_type || value.eventType, {
    limit: EVENT_CAPS.type,
    lower: true,
  });
  if (!CANONICAL_EVENT_TYPES.has(eventType)) {
    return {
      status: 'unsupported',
      event: null,
      diagnostics: [diagnostic('unsupported_event_type', {
        event_type: eventType || 'missing',
      })],
    };
  }
  const capped = capPayload(eventType, value.payload);
  const event = {
    v: CANONICAL_TURN_SCHEMA_VERSION,
    turn_id: turnId,
    seq,
    type: eventType,
    event_id: normalizeId(value.event_id || value.eventId) || `${turnId}:canonical:${seq}`,
    part_id: partIdFor(turnId, eventType, seq, value.part_id || value.partId),
    durability: durabilityFor(eventType, capped.payload),
    payload: capped.payload,
    ts: normalizeToken(value.ts, { limit: 64 }) || nowIso(),
  };
  attachOptionalEnvelopeIds(event, value);
  return {
    status: 'accepted',
    event,
    diagnostics: capped.diagnostics,
  };
}

function reduceToTurnEventKind(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const eventType = normalizeToken(event.type, {
    limit: EVENT_CAPS.type,
    lower: true,
  });
  const durability = normalizeToken(event.durability, { lower: true });
  if (durability !== 'durable') {
    return null;
  }
  return PERSISTED_KIND_BY_TYPE[eventType] || null;
}

module.exports = {
  CANONICAL_EVENT_TYPES,
  CANONICAL_TURN_COUNTER_FIELDS,
  CANONICAL_TURN_SCHEMA_VERSION,
  DURABLE_EVENT_TYPES,
  EPHEMERAL_EVENT_TYPES,
  EVENT_CAPS,
  UNPERSISTED_DURABLE_TYPES,
  buildCanonicalTurnEvent,
  reduceToTurnEventKind,
  validateTurnEvent,
};
