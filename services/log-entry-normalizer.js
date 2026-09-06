const {
  normalizeJennyLevel,
  resolveStructuredLogLevel,
} = require('./log-level-utils');
const { normalizeString } = require('../renderer/shared/string-utils');
const {
  redactLogReportValue,
  redactLogText,
} = require('../renderer/shared/log-contract-utils');

function normalizeLevel(value) {
  return normalizeJennyLevel(value, 'INFO');
}

function toFiniteNumberOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function normalizeRedactionPrefixes(entry = {}, defaults = {}) {
  const values = [];
  for (const source of [defaults.redaction_prefixes, entry.redaction_prefixes]) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const value of source) {
      const text = normalizeString(value);
      if (text) {
        values.push(text);
      }
    }
  }
  return Array.from(new Set(values)).sort((a, b) => b.length - a.length);
}

function redactText(value, { prefixes = [] } = {}) {
  return redactLogText(value, { prefixes });
}

function redactLogValue(value, options = {}, seen = new WeakSet()) {
  return redactLogReportValue(value, options, seen);
}

function deriveComponent(event, fallbackComponent = '') {
  const normalizedEvent = normalizeString(event);
  if (!normalizedEvent.includes('.')) {
    return normalizeString(fallbackComponent) || 'app.main';
  }
  const segments = normalizedEvent.split('.').filter(Boolean);
  if (segments.length < 2) {
    return normalizeString(fallbackComponent) || 'app.main';
  }
  return `${segments[0]}.${segments[1]}`;
}

function resolveEntryLevel(rawLevel, { event = '', details = {}, data = {} } = {}) {
  const fallback = normalizeLevel(rawLevel);
  if (event !== 'ollama.output') {
    return fallback;
  }
  if (
    (!details || typeof details !== 'object')
    && (!data || typeof data !== 'object')
  ) {
    return fallback;
  }
  const outputDetails = { ...(data || {}), ...(details || {}) };
  if (normalizeString(outputDetails.stream).toLowerCase() !== 'stderr') {
    return fallback;
  }
  return resolveStructuredLogLevel({
    line: outputDetails.line,
    defaultLevel: fallback,
  });
}

function normalizeLogEntry(entry = {}, defaults = {}) {
  const details = entry && typeof entry.details === 'object' && !Array.isArray(entry.details)
    ? { ...entry.details }
    : {};
  const layer = pickFirstNonEmpty(entry.layer, entry.source, defaults.layer, 'electron');
  const event = pickFirstNonEmpty(entry.event, defaults.event, `${layer}.event`);
  const component = pickFirstNonEmpty(entry.component, defaults.component, deriveComponent(event));
  const rawMessage = pickFirstNonEmpty(
    entry.message,
    details.message,
    details.error,
    details.reason,
    typeof details.line === 'string' ? details.line : '',
    event
  );
  const status = pickFirstNonEmpty(entry.status, details.status, defaults.status, 'ok');
  const durationMs = toFiniteNumberOrNull(entry.duration_ms ?? details.duration_ms);
  const rawData = entry && typeof entry.data === 'object' && !Array.isArray(entry.data)
    ? { ...entry.data }
    : { ...details };
  const level = resolveEntryLevel(entry.level || defaults.level, { event, details, data: rawData });
  const ts = pickFirstNonEmpty(entry.ts, defaults.ts, new Date().toISOString());
  const redactionMode = pickFirstNonEmpty(entry.redaction_mode, defaults.redaction_mode, 'redacted');
  const shouldRedact = redactionMode === 'redacted';
  const redactionOptions = { prefixes: normalizeRedactionPrefixes(entry, defaults) };
  const message = shouldRedact ? redactText(rawMessage, redactionOptions) : rawMessage;
  const data = shouldRedact ? redactLogValue(rawData, redactionOptions) : rawData;
  const redactedDetails = shouldRedact ? redactLogValue(details, redactionOptions) : details;
  const normalized = {
    ts,
    level,
    layer,
    component,
    event,
    message,
    trace_id: pickFirstNonEmpty(entry.trace_id, details.trace_id, defaults.trace_id),
    request_id: pickFirstNonEmpty(entry.request_id, details.request_id, defaults.request_id),
    session_id: pickFirstNonEmpty(entry.session_id, details.session_id, details.sessionId, defaults.session_id),
    tool_call_id: pickFirstNonEmpty(entry.tool_call_id, details.tool_call_id, details.call_id, details.callId, defaults.tool_call_id),
    approval_id: pickFirstNonEmpty(entry.approval_id, details.approval_id, defaults.approval_id),
    rpc_id: pickFirstNonEmpty(entry.rpc_id, details.rpc_id, defaults.rpc_id),
    status,
    duration_ms: durationMs,
    data,
    redaction_mode: redactionMode,
    schema_version: 1,
  };
  normalized.source = layer;
  normalized.details = {
    ...redactedDetails,
    ...data,
    message: data.message || redactedDetails.message || message,
    status: data.status || redactedDetails.status || status,
  };
  if (entry.id) {
    normalized.id = String(entry.id);
  }
  if (entry.entry_id) {
    normalized.entry_id = String(entry.entry_id);
  }
  if (entry.origin_entry_id) normalized.origin_entry_id = String(entry.origin_entry_id);
  if (entry.run_id) normalized.run_id = String(entry.run_id);
  if (Number.isFinite(Number(entry.sequence))) normalized.sequence = Number(entry.sequence);
  return normalized;
}

function toPersistedMainLog(level, entry = {}) {
  return {
    ts: entry.ts,
    level: normalizeLevel(entry.level || level),
    event: entry.event,
    details: entry.details,
    layer: entry.layer,
    component: entry.component,
    message: entry.message,
    status: entry.status,
    data: entry.data,
    trace_id: entry.trace_id,
    request_id: entry.request_id,
    session_id: entry.session_id,
    tool_call_id: entry.tool_call_id,
    approval_id: entry.approval_id,
    rpc_id: entry.rpc_id,
    redaction_mode: entry.redaction_mode,
    schema_version: entry.schema_version,
    source: entry.source,
    entry_id: entry.entry_id,
    origin_entry_id: entry.origin_entry_id,
    run_id: entry.run_id,
    sequence: entry.sequence,
  };
}

function normalizeRendererDiagnosticsDetails(payload) {
  const report = payload && typeof payload === 'object' ? payload : {};
  return {
    message: String(report.message || 'Renderer error').trim() || 'Renderer error',
    status: 'failed',
    trace_id: String(report.trace_id || '').trim(),
    request_id: String(report.request_id || '').trim(),
    session_id: String(report.session_id || '').trim(),
    category: String(report.category || '').trim() || 'renderer',
    error_code: String(report.error_code || '').trim(),
    retryable: report.retryable === true,
    stack: String(report.stack || '').trim(),
    file: String(report.file || '').trim(),
    line: Number(report.line || 0) || 0,
    column: Number(report.column || 0) || 0,
    dedupe_key: String(report.dedupe_key || '').trim(),
  };
}

module.exports = {
  normalizeLogEntry,
  normalizeRendererDiagnosticsDetails,
  redactLogValue,
  toPersistedMainLog,
};
