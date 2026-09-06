'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { normalizeDestination } = require('../network/destination-policy');
const {
  readNetworkConsent,
  brokerConsentForDestination,
} = require('../store/network-consent-store');

const NETWORK_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const MAX_NETWORK_BODY_BYTES = 64 * 1024;
const IDENTITY_FIELDS = Object.freeze([
  'invocation_id', 'operation_id', 'cancellation_id', 'process_instance_id',
  'channel_id', 'commit_epoch', 'lifecycle_epoch',
]);

function digestText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fail(reason) { return { ok: false, reason }; }

function parsePayload(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value } : fail('capability_payload_invalid');
  } catch (_error) { return fail('capability_payload_invalid'); }
}

function decodeBase64(value) {
  if (typeof value !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

class RestrictedCapabilityBroker {
  constructor({ tokenService, networkBroker, secretHandleBroker, facade,
    baseDir = '', now = () => Date.now() } = {}) {
    this._tokenService = tokenService;
    this._networkBroker = networkBroker;
    this._secretHandleBroker = secretHandleBroker;
    this._facade = facade;
    this._baseDir = baseDir;
    this._now = now;
  }

  _validate(call, authority) {
    const checked = validate('PluginRestrictedCapabilityCallV4', call);
    if (!checked.ok) return fail('capability_call_contract_rejected');
    const value = checked.value;
    if (IDENTITY_FIELDS.some((field) => value[field] !== authority?.[field])
      || value.token_id !== authority?.token_id
      || value.argument_digest !== digestText(value.payload_json)) {
      return fail('capability_call_authority_rejected');
    }
    if (!Array.isArray(authority.capabilities)
      || !authority.capabilities.includes(value.capability)) {
      return fail('capability_not_granted');
    }
    const payload = parsePayload(value.payload_json);
    return payload.ok ? { ok: true, call: value, payload: payload.value } : payload;
  }

  _consume(authority) {
    return this._tokenService.consume(authority.token_id, authority);
  }

  async _network(call, payload, authority, signal) {
    const method = String(payload.method || '').toUpperCase();
    const body = decodeBase64(payload.body_b64);
    const destination = normalizeDestination(payload.url);
    if (!NETWORK_METHODS.has(method) || body === null || body.length > MAX_NETWORK_BODY_BYTES
      || !destination.ok || destination.origin !== authority.destination) {
      return fail('restricted_network_request_rejected');
    }
    const stored = await readNetworkConsent(this._facade, this._baseDir);
    if (!stored.ok) return fail(stored.reason);
    const consent = brokerConsentForDestination(stored.document, {
      publisherId: authority.publisher_id,
      pluginId: authority.plugin_id,
      destination: authority.destination,
    });
    if (!consent.granted) return fail('restricted_network_consent_required');
    const consumed = this._consume(authority);
    if (!consumed.ok) return consumed;
    const result = await this._networkBroker.request({
      purpose: 'restricted_runtime',
      request_id: call.call_id,
      operation_id: authority.operation_id,
      session_id: String(authority.session_id || '').trim(),
      redaction_policy: 'strict',
      deadline_epoch_ms: authority.deadline_epoch_ms,
      url: destination.url.href,
      method,
      body: body.length ? body : null,
      consent,
      signal,
      same_origin_redirects_only: true,
      limits: { max_response_bytes: MAX_NETWORK_BODY_BYTES },
    });
    if (!result.ok) return fail(result.reason || 'restricted_network_request_failed');
    const responseBody = Buffer.isBuffer(result.body)
      ? result.body : Buffer.from(result.body || '');
    if (responseBody.length > MAX_NETWORK_BODY_BYTES) {
      return fail('restricted_network_response_too_large');
    }
    return {
      ok: true,
      payload: { status: result.status_code, body_b64: responseBody.toString('base64') },
    };
  }

  async _secret(payload, authority) {
    if (typeof payload.handle !== 'string' || typeof payload.request_digest !== 'string') {
      return fail('secret_handle_request_invalid');
    }
    const consumed = this._consume(authority);
    if (!consumed.ok) return consumed;
    const result = await this._secretHandleBroker.use(
      payload.handle, payload.request_digest, authority
    );
    return result.ok ? { ok: true, payload: { used: true } } : result;
  }

  async handle(call, authority, { signal = null } = {}) {
    const checked = this._validate(call, authority);
    if (!checked.ok) return checked;
    if (this._now() >= authority.deadline_epoch_ms) {
      return fail('capability_deadline_expired');
    }
    if (checked.call.capability === 'network.request') {
      return this._network(checked.call, checked.payload, authority, signal);
    }
    if (checked.call.capability === 'secret.use_handle') {
      return this._secret(checked.payload, authority);
    }
    return fail('capability_call_kind_rejected');
  }
}

module.exports = {
  NETWORK_METHODS, MAX_NETWORK_BODY_BYTES, IDENTITY_FIELDS,
  digestText, parsePayload, decodeBase64, RestrictedCapabilityBroker,
};
