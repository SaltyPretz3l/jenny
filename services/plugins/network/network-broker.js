'use strict';

const { boundedHttpRequest } = require('./bounded-http-client');
const { resumableDownload } = require('./resumable-download');
const { digestText } = require('./destination-policy');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');

const NETWORK_PURPOSES = Object.freeze([
  'package_url',
  'git_fetch',
  'catalog_refresh',
  'advisory_refresh',
  'oauth_discovery',
  'oauth_registration',
  'oauth_token',
  'remote_mcp',
  'remote_mcp_discovery',
  'remote_mcp_call',
  'restricted_runtime',
]);
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_REQUEST_LIFETIME_MS = 120000;

function createCounterRecord() {
  return {
    requests: 0, succeeded: 0, failed: 0, blocked_destinations: 0,
    redirects: 0, cancellations: 0, timeouts: 0, auth_challenges: 0,
    circuit_breaker_trips: 0,
  };
}

function classifyFailure(reason) {
  if (reason === 'operation_cancelled') return 'cancellations';
  if (String(reason).includes('timeout')) return 'timeouts';
  if (['network_consent_required', 'special_address_blocked', 'https_required',
    'dns_mixed_scope_blocked', 'dns_scope_changed'].includes(reason)) return 'blocked_destinations';
  return null;
}

function validateBrokerInput(input, now) {
  if (!input || !NETWORK_PURPOSES.includes(input.purpose)
    || !REQUEST_ID_PATTERN.test(input.request_id || '')
    || !REQUEST_ID_PATTERN.test(input.operation_id || '')
    || input.redaction_policy !== 'strict'
    || !Number.isSafeInteger(input.deadline_epoch_ms)
    || input.deadline_epoch_ms <= now
    || input.deadline_epoch_ms - now > MAX_REQUEST_LIFETIME_MS) {
    return { ok: false, reason: 'broker_request_invalid' };
  }
  return { ok: true };
}

class NetworkBroker {
  constructor({ request = boundedHttpRequest, now = () => Date.now(),
    isSessionLockedDown = () => false } = {}) {
    this._request = request;
    this._now = now;
    this._isSessionLockedDown = isSessionLockedDown;
    this._counters = new Map(NETWORK_PURPOSES.map((purpose) => [purpose, createCounterRecord()]));
    this._failures = new Map();
  }

  _circuitKey(purpose, url) {
    let origin = 'invalid';
    try { origin = new URL(url).origin.toLowerCase(); } catch (_error) { /* fail in request validation */ }
    return `${purpose}:${digestText(origin)}`;
  }

  _pruneFailures(key, now) {
    const failures = (this._failures.get(key) || []).filter((at) => now - at <= FAILURE_WINDOW_MS);
    if (failures.length) this._failures.set(key, failures);
    else this._failures.delete(key);
    return failures;
  }

  _circuitOpen(key, now) {
    const failures = this._pruneFailures(key, now);
    return failures.length >= CIRCUIT_FAILURE_THRESHOLD
      && now - failures[failures.length - 1] < CIRCUIT_COOLDOWN_MS;
  }

  _recordFailure(key, now) {
    const failures = this._pruneFailures(key, now);
    failures.push(now);
    this._failures.set(key, failures.slice(-CIRCUIT_FAILURE_THRESHOLD));
  }

  getCounters() {
    return Object.fromEntries([...this._counters].map(([purpose, counters]) => [purpose, { ...counters }]));
  }

  async request(input) {
    const now = this._now();
    const validation = validateBrokerInput(input, now);
    const purpose = input?.purpose;
    const counters = this._counters.get(purpose);
    if (!validation.ok || !counters) {
      return { ok: false, code: PLUGIN_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED,
        reason: 'broker_request_invalid', retryable: false,
        operation_id: REQUEST_ID_PATTERN.test(input?.operation_id || '') ? input.operation_id : '' };
    }
    const sessionId = String(input.session_id || '').trim();
    if (!sessionId && ['remote_mcp', 'remote_mcp_call', 'restricted_runtime'].includes(purpose)) {
      return { ok: false, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED,
        reason: 'session_required', retryable: false,
        operation_id: input.operation_id };
    }
    let lockedDown;
    try { lockedDown = Boolean(sessionId && this._isSessionLockedDown(sessionId)); }
    catch (_error) { lockedDown = Boolean(sessionId); }
    if (lockedDown) {
      return { ok: false, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED,
        reason: 'session_offline_lockdown', retryable: false,
        operation_id: input.operation_id };
    }
    counters.requests += 1;
    const circuitKey = this._circuitKey(purpose, input.url);
    if (this._circuitOpen(circuitKey, now)) {
      counters.circuit_breaker_trips += 1;
      counters.failed += 1;
      return { ok: false, code: PLUGIN_ERROR_CODES.REMOTE_TRANSPORT_FAILED,
        reason: 'circuit_breaker_open', retryable: true,
        operation_id: input.operation_id };
    }
    let result;
    try {
      const requestedTimeout = Number.isSafeInteger(input.limits?.total_timeout_ms)
        && input.limits.total_timeout_ms > 0
        ? input.limits.total_timeout_ms : MAX_REQUEST_LIFETIME_MS;
      result = await this._request({
        url: input.url,
        method: input.method || 'GET',
        headers: input.headers || {},
        body: input.body || null,
        consent: input.consent,
        allowLoopbackHttp: input.allow_loopback_http === true,
        limits: {
          ...(input.limits || {}),
          total_timeout_ms: Math.min(
            requestedTimeout,
            input.deadline_epoch_ms - now
          ),
        },
        signal: input.signal || null,
        resolve: input.resolve,
        requestOnce: input.request_once,
        sameOriginRedirectsOnly: input.same_origin_redirects_only === true,
      });
    } catch (_error) {
      result = { ok: false, reason: 'broker_internal_failure', retryable: true };
    }
    if (result.ok) {
      counters.succeeded += 1;
      counters.redirects += result.redirect_count || 0;
      if ([401, 403].includes(result.status_code)) counters.auth_challenges += 1;
      return { ...result, operation_id: input.operation_id };
    }
    counters.failed += 1;
    const failureCounter = classifyFailure(result.reason);
    if (failureCounter) counters[failureCounter] += 1;
    if (result.retryable) this._recordFailure(circuitKey, now);
    const failure = {
      ok: false,
      code: result.reason === 'operation_cancelled'
        ? PLUGIN_ERROR_CODES.OPERATION_CANCELLED
        : PLUGIN_ERROR_CODES.REMOTE_TRANSPORT_FAILED,
      reason: result.reason,
      retryable: result.retryable === true,
      operation_id: input.operation_id,
    };
    if (result.reason === 'response_stream_failed'
      && Buffer.isBuffer(result.partial_body) && result.partial_body.length > 0) {
      failure.partial_body = result.partial_body;
      failure.headers = result.headers;
      failure.status_code = result.status_code;
    }
    return failure;
  }

  async download(input) {
    return resumableDownload({
      request: (requestInput) => this.request(requestInput), requestInput: input,
      sourceIdentityDigest: input.source_identity_digest,
      readPartial: input.read_partial, writePartial: input.write_partial,
      discardPartial: input.discard_partial, maxBytes: input.max_bytes,
    });
  }
}

function createNetworkBroker(options) {
  return new NetworkBroker(options);
}

module.exports = {
  NETWORK_PURPOSES,
  FAILURE_WINDOW_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_COOLDOWN_MS,
  MAX_REQUEST_LIFETIME_MS,
  createCounterRecord,
  classifyFailure,
  validateBrokerInput,
  NetworkBroker,
  createNetworkBroker,
};
