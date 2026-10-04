const {
  normalizeJennyLevel,
  resolveStructuredLogLevel,
} = require('./log-level-utils');
const { normalizeString } = require('./shared/normalize');
const {
  collapseRedactedPathTails,
  normalizeLogIdentifier,
  normalizeLogName,
  normalizeLogStatus,
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

function pickFirstPresent(...values) {
  return values.find((value) => value != null && value !== '');
}

// Sidecar approval/rpc ids are integers; Electron approval ids are string tokens.
function toIdOrNull(value, redactionOptions) {
  return Number.isSafeInteger(value) ? value : normalizeLogIdentifier(value, redactionOptions);
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
  const redactionOptions = { prefixes: normalizeRedactionPrefixes(entry, defaults) };
  const layer = normalizeLogName(pickFirstPresent(entry.layer, entry.source, defaults.layer), redactionOptions) || 'electron';
  const defaultEvent = normalizeLogName(defaults.event, redactionOptions)
    || normalizeLogName(`${layer}.event`, redactionOptions) || 'electron.event';
  const event = normalizeLogName(pickFirstPresent(entry.event, defaults.event), redactionOptions) || defaultEvent;
  const defaultComponent = normalizeLogName(defaults.component, redactionOptions) || deriveComponent(event);
  const component = normalizeLogName(pickFirstPresent(entry.component, defaults.component), redactionOptions) || defaultComponent;
  const rawMessage = pickFirstNonEmpty(
    entry.message,
    details.message,
    details.error,
    details.reason,
    typeof details.line === 'string' ? details.line : '',
    event
  );
  const status = normalizeLogStatus(pickFirstPresent(entry.status, details.status, defaults.status), redactionOptions);
  const durationMs = toFiniteNumberOrNull(entry.duration_ms ?? details.duration_ms);
  const rawData = entry && typeof entry.data === 'object' && !Array.isArray(entry.data)
    ? { ...entry.data }
    : { ...details };
  const level = resolveEntryLevel(entry.level || defaults.level, { event, details, data: rawData });
  const rawTs = pickFirstNonEmpty(entry.ts, defaults.ts, new Date().toISOString());
  const ts = redactText(rawTs, redactionOptions) === rawTs ? rawTs : new Date().toISOString();
  const requestedMode = pickFirstNonEmpty(entry.redaction_mode, defaults.redaction_mode, 'redacted');
  const redactionMode = requestedMode === 'sanitized_snippets' ? requestedMode : 'redacted';
  const message = redactText(rawMessage, redactionOptions);
  const data = redactLogValue(rawData, redactionOptions);
  const redactedDetails = redactLogValue(details, redactionOptions);
  const normalized = {
    ts,
    level,
    layer,
    component,
    event,
    message,
    trace_id: normalizeLogIdentifier(pickFirstPresent(entry.trace_id, details.trace_id, defaults.trace_id), redactionOptions),
    request_id: normalizeLogIdentifier(pickFirstPresent(entry.request_id, details.request_id, defaults.request_id), redactionOptions),
    session_id: normalizeLogIdentifier(pickFirstPresent(entry.session_id, details.session_id, details.sessionId, defaults.session_id), redactionOptions),
    tool_call_id: normalizeLogIdentifier(pickFirstPresent(entry.tool_call_id, details.tool_call_id, details.call_id, details.callId, defaults.tool_call_id), redactionOptions),
    approval_id: toIdOrNull(pickFirstPresent(entry.approval_id, details.approval_id, defaults.approval_id), redactionOptions),
    rpc_id: toIdOrNull(pickFirstPresent(entry.rpc_id, details.rpc_id, defaults.rpc_id), redactionOptions),
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
  for (const key of ['agent_id', 'stream_id', 'id', 'entry_id', 'origin_entry_id', 'run_id']) {
    const value = normalizeLogIdentifier(pickFirstPresent(entry[key], details[key], defaults[key]), redactionOptions);
    if (value) normalized[key] = value;
  }
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
    agent_id: entry.agent_id,
    stream_id: entry.stream_id,
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
  collapseRedactedPathTails,
  normalizeLogEntry,
  normalizeRendererDiagnosticsDetails,
  redactLogValue,
  toPersistedMainLog,
};
