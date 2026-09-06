'use strict';

const { inspectStructure } = require('./json-schema-validator');

const DEFAULT_LIMITS = Object.freeze({ max_bytes: 8 * 1024 * 1024,
  max_line_bytes: 64 * 1024, max_events: 10000, max_depth: 32,
  max_nodes: 65536, max_keys: 1024, max_array_items: 10000 });

function parseEventData(lines) {
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (!['event', 'id', 'retry'].includes(field)) return { ok: false, reason: 'sse_field_invalid' };
  }
  if (!data.length) return { ok: true, empty: true };
  try { return { ok: true, value: JSON.parse(data.join('\n')) }; }
  catch (_error) { return { ok: false, reason: 'sse_json_invalid' }; }
}

function parseMcpSse(body, requestId, limits = DEFAULT_LIMITS) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  if (bytes.length > limits.max_bytes) return { ok: false, reason: 'sse_byte_limit_exceeded' };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_error) { return { ok: false, reason: 'sse_utf8_invalid' }; }
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => Buffer.byteLength(line, 'utf8') > limits.max_line_bytes)) {
    return { ok: false, reason: 'sse_line_limit_exceeded' };
  }
  const notifications = [];
  let response = null;
  let current = [];
  let eventCount = 0;
  const settle = () => {
    if (!current.length) return { ok: true };
    eventCount += 1;
    if (eventCount > limits.max_events) return { ok: false, reason: 'sse_event_limit_exceeded' };
    const parsed = parseEventData(current); current = [];
    if (!parsed.ok || parsed.empty) return parsed;
    const message = parsed.value;
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.jsonrpc !== '2.0') return { ok: false, reason: 'mcp_message_invalid' };
    const structured = inspectStructure(message, {
      max_bytes: limits.max_bytes, max_depth: limits.max_depth, max_nodes: limits.max_nodes,
      max_keys: limits.max_keys, max_array_items: limits.max_array_items,
    });
    if (!structured.ok) return { ok: false, reason: 'mcp_response_structure_exceeded' };
    if (Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id')) {
      return { ok: false, reason: 'server_initiated_request_unsupported' };
    }
    if (Object.hasOwn(message, 'method')) {
      if (response) return { ok: false, reason: 'sse_message_after_response' };
      notifications.push(message); return { ok: true };
    }
    if (message.id !== requestId || response) return { ok: false, reason: 'mcp_response_id_invalid' };
    response = message; return { ok: true };
  };
  for (const line of lines) {
    if (line === '') { const result = settle(); if (!result.ok) return result; }
    else current.push(line);
  }
  const final = settle();
  if (!final.ok) return final;
  return response ? { ok: true, response, notifications, event_count: eventCount }
    : { ok: false, reason: 'mcp_response_missing' };
}

module.exports = { DEFAULT_LIMITS, parseEventData, parseMcpSse };
