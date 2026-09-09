'use strict';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const {
  PRIVATE_HTTPS,
  PRIVATE_COOKIE_NAME,
  createBrowserAccessPolicy,
} = require('./browser-access-policy');

// Kept as the compatibility export for existing API callers. Route-specific
// code uses the validated policy's cookie name and parser instead.
const AUTH_COOKIE_NAME = PRIVATE_COOKIE_NAME;

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

function serializeSessionCookie(token, { maxAgeSeconds = 30 * 24 * 60 * 60 } = {}) {
  return createBrowserAccessPolicy({ browserAccessMode: PRIVATE_HTTPS, canonicalOrigin: 'https://jenny.invalid' })
    .serializeSessionCookie(token, { maxAgeSeconds });
}

function serializeLogoutCookie() {
  return createBrowserAccessPolicy({ browserAccessMode: PRIVATE_HTTPS, canonicalOrigin: 'https://jenny.invalid' })
    .serializeLogoutCookie();
}

function createRequestSecurity({ canonicalOrigin, canonicalHost, browserAccessMode = PRIVATE_HTTPS,
  port, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const policy = createBrowserAccessPolicy({ browserAccessMode, canonicalOrigin, canonicalHost, port });
  const limit = Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_MAX_BODY_BYTES;

  function validateHostAndOrigin(headers, { method = 'GET', mutation = false, login = false } = {}) {
    const host = header(headers, 'host');
    if (host !== policy.canonicalHost) return { ok: false, code: 'AUTH_HOST_MISMATCH' };
    const verb = String(method || 'GET').toUpperCase();
    const isMutation = mutation || !['GET', 'HEAD', 'OPTIONS'].includes(verb);
    const origin = header(headers, 'origin');
    if (isMutation || login) {
      if (origin !== policy.canonicalOrigin) return { ok: false, code: 'AUTH_ORIGIN_MISMATCH' };
    } else if (origin !== undefined && origin !== policy.canonicalOrigin) {
      return { ok: false, code: 'AUTH_ORIGIN_MISMATCH' };
    }
    if (login && String(header(headers, 'content-type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return { ok: false, code: 'AUTH_JSON_REQUIRED' };
    }
    return { ok: true };
  }

  function checkBodySize(bodyOrLength) {
    let bytes;
    if (typeof bodyOrLength === 'number') bytes = bodyOrLength;
    else if (typeof bodyOrLength === 'string') bytes = Buffer.byteLength(bodyOrLength, 'utf8');
    else if (Buffer.isBuffer(bodyOrLength) || bodyOrLength instanceof Uint8Array) bytes = bodyOrLength.byteLength;
    else {
      try { bytes = Buffer.byteLength(JSON.stringify(bodyOrLength ?? null), 'utf8'); }
      catch (_error) { bytes = Number.POSITIVE_INFINITY; }
    }
    return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= limit
      ? { ok: true, bytes, maxBytes: limit }
      : { ok: false, code: 'AUTH_BODY_TOO_LARGE', bytes, maxBytes: limit };
  }

  function parseJsonBody(body) {
    const checked = checkBodySize(body);
    if (!checked.ok) return checked;
    try {
      const value = JSON.parse(
        Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : String(body)
      );
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'AUTH_JSON_INVALID' };
      return { ok: true, value };
    } catch (_error) {
      return { ok: false, code: 'AUTH_JSON_INVALID' };
    }
  }

  function declaredBodySize(headers) {
    const value = header(headers, 'content-length');
    if (value === undefined) return { ok: true };
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return { ok: false, code: 'AUTH_BODY_TOO_LARGE' };
    return checkBodySize(Number(value.trim()));
  }

  async function callAuth(authService, method, ...args) {
    try {
      if (!authService || typeof authService[method] !== 'function') return { ok: false, code: 'AUTH_UNAVAILABLE' };
      const result = await authService[method](...args);
      if (method === 'validateCsrf') return result === true;
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return { ok: false, code: 'AUTH_UNAVAILABLE' };
      if (result.ok && ['authenticateCookie', 'bootstrap'].includes(method)
        && typeof result.session?.id !== 'string') return { ok: false, code: 'AUTH_UNAVAILABLE' };
      return result;
    } catch (_error) {
      // The HTTP edge never leaks provider, filesystem, or exception text.
      return { ok: false, code: 'AUTH_UNAVAILABLE' };
    }
  }

  async function authenticateCookie(authService, request) {
    const checked = validateHostAndOrigin(request?.headers, request);
    if (!checked.ok) return checked;
    const token = policy.parseCookieHeader(header(request?.headers, 'cookie'))[policy.cookieName];
    return callAuth(authService, 'authenticateCookie', token);
  }

  async function login(authService, request) {
    const method = String(request?.method || 'POST').toUpperCase();
    if (method !== 'POST') return { ok: false, code: 'AUTH_METHOD_NOT_ALLOWED' };
    const checked = validateHostAndOrigin(request?.headers, { ...request, method, mutation: true, login: true });
    if (!checked.ok) return checked;
    const declared = declaredBodySize(request?.headers);
    if (!declared.ok) return declared;
    const parsedBody = parseJsonBody(request?.body ?? '');
    if (!parsedBody.ok) return parsedBody;
    if (Object.keys(parsedBody.value).some((key) => key !== 'password')) return { ok: false, code: 'AUTH_JSON_INVALID' };
    const result = await callAuth(authService, 'login', { ...parsedBody.value, rateKey: request?.rateKey });
    if (!result.ok) return result;
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.token || '') || !/^[A-Za-z0-9_-]{43}$/.test(result.csrfToken || '')) {
      return { ok: false, code: 'AUTH_UNAVAILABLE' };
    }
    // The opaque auth token is transport-only. Keep it inside Set-Cookie and
    // never put it in the JSON response where browser JavaScript could read it.
    const { token: _token, cookie: _cookie, ...publicResult } = result;
    return { ...publicResult, setCookie: policy.serializeSessionCookie(result.token) };
  }

  async function logout(authService, request) {
    const method = String(request?.method || 'POST').toUpperCase();
    if (method !== 'POST') return { ok: false, code: 'AUTH_METHOD_NOT_ALLOWED' };
    const checked = validateHostAndOrigin(request?.headers, { ...request, method, mutation: true });
    if (!checked.ok) return checked;
    const token = policy.parseCookieHeader(header(request?.headers, 'cookie'))[policy.cookieName];
    const csrf = header(request?.headers, 'x-csrf-token');
    const authenticated = await callAuth(authService, 'authenticateCookie', token, { touch: false });
    if (!authenticated.ok) return authenticated;
    if ((await callAuth(authService, 'validateCsrf', token, csrf)) !== true) return { ok: false, code: 'AUTH_CSRF_INVALID' };
    const result = await callAuth(authService, 'logout', token);
    return result.ok ? { ...result, clearCookie: policy.serializeLogoutCookie() } : result;
  }

  async function bootstrap(authService, request) {
    const method = String(request?.method || 'GET').toUpperCase();
    if (method !== 'GET') return { ok: false, code: 'AUTH_METHOD_NOT_ALLOWED' };
    const checked = validateHostAndOrigin(request?.headers, { ...request, method });
    if (!checked.ok) return checked;
    const token = policy.parseCookieHeader(header(request?.headers, 'cookie'))[policy.cookieName];
    return callAuth(authService, 'bootstrap', token);
  }

  async function authorizeMutation(authService, request) {
    const checked = validateHostAndOrigin(request?.headers, { ...request, mutation: true });
    if (!checked.ok) return checked;
    const token = policy.parseCookieHeader(header(request?.headers, 'cookie'))[policy.cookieName];
    const authenticated = await callAuth(authService, 'authenticateCookie', token, { touch: false });
    if (!authenticated.ok) return authenticated;
    if ((await callAuth(authService, 'validateCsrf', token, header(request?.headers, 'x-csrf-token'))) !== true) {
      return { ok: false, code: 'AUTH_CSRF_INVALID' };
    }
    // Refresh the idle window only after both authentication checks pass. The
    // AuthService keeps this durable touch throttled to at most once a minute.
    return callAuth(authService, 'authenticateCookie', token);
  }

  return Object.freeze({
    browserAccessMode: policy.browserAccessMode,
    cookieName: policy.cookieName,
    canonicalOrigin: policy.canonicalOrigin,
    canonicalHost: policy.canonicalHost,
    maxBodyBytes: limit,
    validateHostAndOrigin,
    checkBodySize,
    parseJsonBody,
    parseCookieHeader: policy.parseCookieHeader,
    authenticateCookie,
    login,
    bootstrap,
    logout,
    authorizeMutation,
    serializeSessionCookie: policy.serializeSessionCookie,
    serializeLogoutCookie: policy.serializeLogoutCookie,
  });
}

module.exports = {
  AUTH_COOKIE_NAME,
  DEFAULT_MAX_BODY_BYTES,
  createRequestSecurity,
  parseCookieHeader: (value) => createBrowserAccessPolicy({ browserAccessMode: PRIVATE_HTTPS, canonicalOrigin: 'https://jenny.invalid' }).parseCookieHeader(value),
  serializeSessionCookie,
  serializeLogoutCookie,
};
