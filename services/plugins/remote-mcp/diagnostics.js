'use strict';

const SAFE_FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_VALUE = /^[\x20-\x7E]{0,200}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function boundedReason(value) {
  return String(value || 'unknown').replace(/[^a-z0-9_-]/gi, '_').slice(0, 200).toLowerCase();
}

function sanitizeDiagnosticFields(fields = {}) {
  const output = {};
  for (const [key, value] of Object.entries(fields)) {
    if (Object.keys(output).length >= 8) break;
    if (!SAFE_FIELD.test(key) || /(url|uri|query|header|token|secret|argument|result|path|body)/i.test(key)) continue;
    if (DIGEST_RE.test(String(value || ''))) output[key] = String(value);
    else if (typeof value === 'boolean' || (Number.isSafeInteger(value) && Math.abs(value) <= 1e9)) output[key] = value;
    else if (typeof value === 'string' && SAFE_VALUE.test(value)) output[key] = boundedReason(value);
  }
  return output;
}

function createRemoteMcpDiagnostics(log = null) {
  const sink = typeof log === 'function' ? log : () => {};
  return Object.freeze({
    emit(level, event, fields = {}) {
      const safeLevel = ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level) ? level : 'INFO';
      const safeEvent = /^plugins\.remote_mcp\.[a-z][a-z0-9_]{0,63}$/.test(event)
        ? event : 'plugins.remote_mcp.invalid_event';
      sink(safeLevel, safeEvent, sanitizeDiagnosticFields(fields));
    },
  });
}

module.exports = { boundedReason, sanitizeDiagnosticFields, createRemoteMcpDiagnostics };
