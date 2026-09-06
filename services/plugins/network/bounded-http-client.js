'use strict';

const http = require('node:http');
const https = require('node:https');
const { normalizeDestination } = require('./destination-policy');
const { pinDestination } = require('./dns-pinning');

const DEFAULT_LIMITS = Object.freeze({
  max_redirects: 5,
  connect_timeout_ms: 10000,
  first_byte_timeout_ms: 15000,
  total_timeout_ms: 120000,
  max_response_bytes: 2 * 1024 * 1024,
});
const MAX_LIMITS = Object.freeze({ ...DEFAULT_LIMITS, max_response_bytes: 64 * 1024 * 1024 });
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

function boundedReason(value) {
  return String(value || 'transport_failed').replace(/[^a-z0-9_-]/g, '_').slice(0, 200);
}

function createPinnedLookup(pin) {
  return (_hostname, options, callback) => {
    if (options?.all) return callback(null, [{ address: pin.address, family: pin.family }]);
    return callback(null, pin.address, pin.family);
  };
}

function defaultNodeRequest({ destination, pin, method, headers, body, limits, signal }) {
  return new Promise((resolve) => {
    let settled = false;
    let abort = null;
    let firstByteTimer = null;
    let connectTimer = null;
    let totalTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstByteTimer);
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      if (abort) signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const transport = destination.url.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers, host: destination.url.host };
    const request = transport.request({
      protocol: destination.url.protocol,
      hostname: destination.hostname,
      port: destination.url.port || undefined,
      path: `${destination.url.pathname}${destination.url.search}`,
      method,
      headers: requestHeaders,
      agent: false,
      servername: destination.hostname,
      lookup: createPinnedLookup(pin),
    });
    abort = () => {
      request.destroy();
      finish({ ok: false, reason: 'operation_cancelled', retryable: false });
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    totalTimer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, reason: 'total_timeout', retryable: true });
    }, limits.total_timeout_ms);
    request.on('socket', (socket) => {
      connectTimer = setTimeout(() => {
        request.destroy();
        finish({ ok: false, reason: 'connect_timeout', retryable: true });
      }, limits.connect_timeout_ms);
      const connectedEvent = destination.url.protocol === 'https:' ? 'secureConnect' : 'connect';
      socket.once(connectedEvent, () => {
        clearTimeout(connectTimer);
        firstByteTimer = setTimeout(() => {
          request.destroy();
          finish({ ok: false, reason: 'first_byte_timeout', retryable: true });
        }, limits.first_byte_timeout_ms);
      });
    });
    request.on('response', (response) => {
      clearTimeout(firstByteTimer);
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > limits.max_response_bytes) {
        response.destroy();
        return finish({ ok: false, reason: 'response_too_large', retryable: false });
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > limits.max_response_bytes) {
          response.destroy();
          finish({ ok: false, reason: 'response_too_large', retryable: false });
        } else {
          chunks.push(Buffer.from(chunk));
        }
      });
      response.on('end', () => finish({
        ok: true,
        status_code: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', () => finish(chunks.length ? {
        ok: false, reason: 'response_stream_failed', retryable: true,
        partial_body: Buffer.concat(chunks), headers: response.headers,
        status_code: response.statusCode || 0,
      } : { ok: false, reason: 'response_stream_failed', retryable: true }));
    });
    request.on('error', () => finish({ ok: false, reason: 'transport_failed', retryable: true }));
    if (body?.length) request.write(body);
    request.end();
  });
}

function normalizedLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > MAX_LIMITS[key]) {
      limits[key] = fallback;
    }
  }
  return limits;
}

function redirectTarget(response, destination) {
  const status = response.status_code;
  if (![301, 302, 303, 307, 308].includes(status)) return { redirect: false };
  const location = response.headers?.location;
  if (typeof location !== 'string' || !location) return { redirect: false };
  try {
    return { redirect: true, url: new URL(location, destination.url).href, status };
  } catch (_error) {
    return { redirect: true, error: 'redirect_invalid' };
  }
}

function redirectMethod(method, status) {
  if (status === 303) return { ok: true, method: 'GET', dropBody: true };
  if ([301, 302].includes(status) && method !== 'GET' && method !== 'HEAD') {
    return { ok: false, reason: 'unsafe_redirect_method' };
  }
  return { ok: true, method, dropBody: false };
}

function stripSensitiveHeaders(headers) {
  for (const key of Object.keys(headers)) {
    if (['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) delete headers[key];
  }
}

function validateOutboundRequest(headers, body) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return { ok: false, reason: 'headers_invalid' };
  }
  let headerBytes = 0;
  for (const [key, value] of Object.entries(headers)) {
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(text)) {
      return { ok: false, reason: 'headers_invalid' };
    }
    headerBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(text, 'utf8') + 4;
  }
  if (headerBytes > MAX_HEADER_BYTES) return { ok: false, reason: 'headers_too_large' };
  if (body !== null) {
    if (!(typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array)) {
      return { ok: false, reason: 'request_body_invalid' };
    }
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      return { ok: false, reason: 'request_body_too_large' };
    }
  }
  return { ok: true };
}

async function boundedHttpRequest({
  url,
  method = 'GET',
  headers = {},
  body = null,
  consent,
  allowLoopbackHttp = false,
  limits: limitOverrides = {},
  signal = null,
  resolve,
  requestOnce = defaultNodeRequest,
  sameOriginRedirectsOnly = false,
}) {
  const limits = normalizedLimits(limitOverrides);
  const outbound = validateOutboundRequest(headers, body);
  if (!outbound.ok) return { ...outbound, retryable: false };
  let nextUrl = url;
  let nextMethod = String(method).toUpperCase();
  let nextBody = body === null ? null : Buffer.from(body);
  let nextHeaders = { ...headers };
  let originalScope = null;
  for (let redirectCount = 0; redirectCount <= limits.max_redirects; redirectCount += 1) {
    if (signal?.aborted) return { ok: false, reason: 'operation_cancelled', retryable: false };
    const destination = normalizeDestination(nextUrl, { allowLoopbackHttp });
    if (!destination.ok) return { ...destination, retryable: false };
    const pinned = await pinDestination(destination, { consent, resolve, expectedScope: originalScope });
    if (!pinned.ok) return { ...pinned, retryable: pinned.retryable === true };
    if (originalScope === null) originalScope = pinned.scope;
    const response = await requestOnce({
      destination,
      pin: pinned.selected,
      method: nextMethod,
      headers: { ...nextHeaders },
      body: nextBody,
      limits,
      signal,
    });
    if (!response.ok) return { ...response, reason: boundedReason(response.reason) };
    const redirect = redirectTarget(response, destination);
    if (!redirect.redirect) {
      return {
        ...response,
        endpoint_origin_digest: destination.origin_digest,
        destination_digest: destination.destination_digest,
        destination_scope: pinned.scope,
        redirect_count: redirectCount,
      };
    }
    if (redirect.error) return { ok: false, reason: redirect.error, retryable: false };
    if (redirectCount === limits.max_redirects) {
      return { ok: false, reason: 'redirect_limit_exceeded', retryable: false };
    }
    const redirected = normalizeDestination(redirect.url, { allowLoopbackHttp });
    if (!redirected.ok) return { ...redirected, retryable: false };
    if (sameOriginRedirectsOnly && redirected.origin !== destination.origin) {
      return { ok: false, reason: 'redirect_origin_changed', retryable: false };
    }
    const methodResult = redirectMethod(nextMethod, redirect.status);
    if (!methodResult.ok) return { ...methodResult, retryable: false };
    if (sameOriginRedirectsOnly && methodResult.dropBody) {
      return { ok: false, reason: 'unsafe_redirect_method', retryable: false };
    }
    if (redirected.origin !== destination.origin) {
      stripSensitiveHeaders(nextHeaders);
    }
    nextUrl = redirect.url;
    nextMethod = methodResult.method;
    if (methodResult.dropBody) nextBody = null;
  }
  return { ok: false, reason: 'redirect_limit_exceeded', retryable: false };
}

module.exports = {
  DEFAULT_LIMITS,
  MAX_LIMITS,
  MAX_REQUEST_BYTES,
  MAX_HEADER_BYTES,
  boundedReason,
  createPinnedLookup,
  defaultNodeRequest,
  normalizedLimits,
  redirectTarget,
  redirectMethod,
  stripAuthorization: stripSensitiveHeaders,
  stripSensitiveHeaders,
  validateOutboundRequest,
  boundedHttpRequest,
};
