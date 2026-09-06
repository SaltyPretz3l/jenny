'use strict';

const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { encodeHeaderValue, inspectStructure } = require('./json-schema-validator');
const { parseMcpSse } = require('./sse-parser');

const PRIMARY_PROTOCOL = '2026-07-28';
const FALLBACK_PROTOCOL = '2025-11-25';
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const CLIENT_INFO = Object.freeze({ name: 'Jenny', version: '0.9.1' });
const RESPONSE_STRUCTURE_LIMITS = Object.freeze({ max_bytes: RESPONSE_MAX_BYTES,
  max_depth: 32, max_nodes: 65536, max_keys: 1024, max_array_items: 10000 });

function decodeUtf8(body) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(body || [])); }
  catch (_error) { return null; }
}

function failure(reason, retryable = false, code = PLUGIN_ERROR_CODES.REMOTE_TRANSPORT_FAILED) {
  return { ok: false, code, reason, retryable };
}

function boundedId(prefix, value) {
  const source = `${prefix}-${value}`;
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) return source;
  return `${prefix}-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 48)}`;
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value[0] : value;
}

function parseJsonRpcBody(body, requestId) {
  let message;
  try {
    const text = decodeUtf8(body);
    if (text === null) return failure('mcp_json_invalid');
    message = JSON.parse(text);
  }
  catch (_error) { return failure('mcp_json_invalid'); }
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || message.jsonrpc !== '2.0' || message.id !== requestId
    || (Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id'))
    || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))
    || (message.error && (!Number.isSafeInteger(message.error.code)
      || typeof message.error.message !== 'string'))) {
    return failure('mcp_response_invalid');
  }
  if (!inspectStructure(message, RESPONSE_STRUCTURE_LIMITS).ok) {
    return failure('mcp_response_structure_exceeded');
  }
  return { ok: true, response: message, notifications: [] };
}

function parseTransportResponse(result, requestId) {
  if (!result?.ok) return failure(result?.reason || 'remote_transport_failed', result?.retryable === true,
    result?.code || PLUGIN_ERROR_CODES.REMOTE_TRANSPORT_FAILED);
  if (result.status_code === 401 || result.status_code === 403) {
    return { ok: false, code: PLUGIN_ERROR_CODES.REMOTE_AUTH_REQUIRED,
      reason: result.status_code === 403 ? 'remote_scope_required' : 'remote_authorization_required',
      retryable: false, status_code: result.status_code,
      www_authenticate: String(headerValue(result.headers, 'www-authenticate') || '').slice(0, 8192) };
  }
  if (result.status_code < 200 || result.status_code >= 300) {
    const parsed = Buffer.isBuffer(result.body) && result.body.length
      ? parseJsonRpcBody(result.body, requestId) : null;
    return { ...failure('remote_http_status', result.status_code >= 500),
      status_code: result.status_code, response: parsed?.ok ? parsed.response : null };
  }
  const contentType = String(headerValue(result.headers, 'content-type') || '').split(';', 1)[0]
    .trim().toLowerCase();
  if (contentType === 'text/event-stream') return parseMcpSse(result.body, requestId);
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    return parseJsonRpcBody(result.body, requestId);
  }
  return failure('mcp_content_type_unsupported');
}

class RemoteMcpTransport {
  constructor({ networkBroker, binding, consent, credential = null, context,
    clientInfo = CLIENT_INFO } = {}) {
    this._broker = networkBroker;
    this._binding = binding;
    this._consent = consent;
    this._credential = credential;
    this._context = context;
    this._clientInfo = clientInfo;
    this._protocol = null;
    this._sessionId = null;
    this._sequence = 0;
  }

  get protocol() { return this._protocol; }

  _nextId(label) {
    this._sequence += 1;
    return boundedId(label, `${this._context.request_id}-${this._sequence}`);
  }

  _modernParams(params) {
    return { ...(params || {}), _meta: {
      ...(params?._meta || {}),
      'io.modelcontextprotocol/protocolVersion': PRIMARY_PROTOCOL,
      'io.modelcontextprotocol/clientInfo': this._clientInfo,
      'io.modelcontextprotocol/clientCapabilities': {},
    } };
  }

  async _post({ method, params = {}, protocol, purpose, id = this._nextId('mcp'),
    notification = false, extraHeaders = {} }) {
    const modern = protocol === PRIMARY_PROTOCOL;
    const body = { jsonrpc: '2.0', ...(notification ? {} : { id }), method,
      params: modern ? this._modernParams(params) : params };
    const headers = {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocol,
      ...(modern ? { 'Mcp-Method': method } : {}),
      ...(modern && ['tools/call', 'resources/read', 'prompts/get'].includes(method)
        ? { 'Mcp-Name': encodeHeaderValue(params.name ?? params.uri) } : {}),
      ...(this._sessionId ? { 'Mcp-Session-Id': this._sessionId } : {}),
      ...(this._credential?.access_token
        ? { authorization: `Bearer ${this._credential.access_token}` } : {}),
      ...extraHeaders,
    };
    const result = await this._broker.request({
      purpose, request_id: this._nextId('request'), operation_id: this._context.operation_id,
      session_id: String(this._context.session_id || '').trim(),
      url: this._binding.endpoint_url, method: 'POST', headers,
      body: JSON.stringify(body), consent: this._consent, redaction_policy: 'strict',
      deadline_epoch_ms: this._context.deadline_epoch_ms,
      limits: { max_response_bytes: RESPONSE_MAX_BYTES,
        total_timeout_ms: this._context.total_timeout_ms || 30000 },
      signal: this._context.signal || null, same_origin_redirects_only: true,
    });
    if (result.ok && result.endpoint_origin_digest !== this._binding.endpoint_origin_digest) {
      return failure('endpoint_origin_changed');
    }
    if (notification) {
      return result.ok && result.status_code === 202
        ? { ok: true } : failure('mcp_notification_rejected', result?.retryable === true);
    }
    return { ...parseTransportResponse(result, id),
      session_id_header: headerValue(result?.headers, 'mcp-session-id') };
  }

  async _initializeLegacy() {
    const initialized = await this._post({
      method: 'initialize', protocol: FALLBACK_PROTOCOL, purpose: 'remote_mcp_discovery',
      params: { protocolVersion: FALLBACK_PROTOCOL, capabilities: {}, clientInfo: this._clientInfo },
    });
    if (!initialized.ok || initialized.response?.result?.protocolVersion !== FALLBACK_PROTOCOL) {
      return failure('legacy_mcp_initialize_failed');
    }
    const sessionId = initialized.session_id_header;
    if (sessionId !== undefined && sessionId !== null) {
      if (typeof sessionId !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(sessionId)) {
        return failure('legacy_mcp_session_invalid');
      }
      this._sessionId = sessionId;
    }
    const notified = await this._post({ method: 'notifications/initialized', params: {},
      protocol: FALLBACK_PROTOCOL, purpose: 'remote_mcp_discovery', notification: true });
    return notified.ok ? { ok: true } : notified;
  }

  async negotiate() {
    if (this._protocol) return { ok: true, protocol: this._protocol };
    if (!this._binding.protocol_versions.includes(PRIMARY_PROTOCOL)) {
      if (!this._binding.protocol_versions.includes(FALLBACK_PROTOCOL)) {
        return failure('remote_protocol_unsupported', false,
          PLUGIN_ERROR_CODES.REMOTE_PROTOCOL_UNSUPPORTED);
      }
      const legacy = await this._initializeLegacy();
      if (legacy.ok) this._protocol = FALLBACK_PROTOCOL;
      return legacy.ok ? { ok: true, protocol: this._protocol } : legacy;
    }
    const discovered = await this._post({ method: 'server/discover', params: {},
      protocol: PRIMARY_PROTOCOL, purpose: 'remote_mcp_discovery' });
    if (discovered.ok) {
      const versions = discovered.response?.result?.supportedVersions;
      const capabilities = discovered.response?.result?.capabilities;
      if (!Array.isArray(versions) || versions.length > 8
        || versions.some((version) => typeof version !== 'string')
        || !versions.includes(PRIMARY_PROTOCOL) || !capabilities
        || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        return failure('remote_protocol_unsupported', false,
          PLUGIN_ERROR_CODES.REMOTE_PROTOCOL_UNSUPPORTED);
      }
      this._protocol = PRIMARY_PROTOCOL;
      return { ok: true, protocol: this._protocol, discovery: discovered.response.result };
    }
    const recognizedModernError = discovered.response?.error
      && [-32020, -32601].includes(discovered.response.error.code);
    const legacyEraSignal = discovered.reason === 'remote_http_status'
      && [400, 404, 405].includes(discovered.status_code) && !recognizedModernError;
    if (!legacyEraSignal || !this._binding.protocol_versions.includes(FALLBACK_PROTOCOL)) {
      return discovered;
    }
    const legacy = await this._initializeLegacy();
    if (legacy.ok) this._protocol = FALLBACK_PROTOCOL;
    return legacy.ok ? { ok: true, protocol: this._protocol } : legacy;
  }

  async call(method, params = {}, { purpose = 'remote_mcp_call', extraHeaders = {} } = {}) {
    const negotiated = await this.negotiate();
    if (!negotiated.ok) return negotiated;
    const result = await this._post({ method, params, protocol: this._protocol, purpose, extraHeaders });
    if (!result.ok) return result;
    if (result.response?.error) return { ok: false, code: PLUGIN_ERROR_CODES.REMOTE_TRANSPORT_FAILED,
      reason: 'remote_mcp_error', retryable: false, remote_error_code: result.response.error.code };
    return { ok: true, result: result.response?.result, notifications: result.notifications || [] };
  }
}

module.exports = {
  PRIMARY_PROTOCOL,
  FALLBACK_PROTOCOL,
  RESPONSE_MAX_BYTES,
  RESPONSE_STRUCTURE_LIMITS,
  decodeUtf8,
  boundedId,
  headerValue,
  parseJsonRpcBody,
  parseTransportResponse,
  RemoteMcpTransport,
};
