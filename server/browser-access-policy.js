'use strict';

const PRIVATE_HTTPS = 'private_https';
const LOCALHOST_HTTP = 'localhost_http';
const BROWSER_ACCESS_MODES = Object.freeze([PRIVATE_HTTPS, LOCALHOST_HTTP]);

const PRIVATE_COOKIE_NAME = '__Host-jenny';
const LOCALHOST_COOKIE_NAME = 'jenny-localhost';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const LOCAL_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

function invalid(message) {
  throw new TypeError(message);
}

function normalizeBrowserAccessMode(value = PRIVATE_HTTPS) {
  if (typeof value !== 'string' || !BROWSER_ACCESS_MODES.includes(value)) {
    invalid('browserAccessMode must be private_https or localhost_http.');
  }
  return value;
}

function parseCanonicalOrigin(canonicalOrigin, mode, configuredPort) {
  if (typeof canonicalOrigin !== 'string' || canonicalOrigin.length === 0) {
    invalid('canonicalOrigin is required.');
  }
  if (mode === LOCALHOST_HTTP) {
    const match = LOCAL_ORIGIN_PATTERN.exec(canonicalOrigin);
    const port = Number(match?.[1]);
    if (!match || String(port) !== match[1] || !Number.isInteger(port) || port < 1 || port > 65535
      || (configuredPort !== undefined && port !== configuredPort)) {
      invalid('localhost_http requires the exact http://127.0.0.1:<port> origin.');
    }
    return { origin: canonicalOrigin, host: `127.0.0.1:${port}`, port };
  }
  let parsed;
  try { parsed = new URL(canonicalOrigin); } catch (_error) {
    invalid('canonicalOrigin must be a valid URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    invalid('canonicalOrigin must be an HTTPS origin without credentials or a path.');
  }
  return { origin: parsed.origin, host: parsed.host, port: parsed.port ? Number(parsed.port) : 443 };
}

function parseCookieHeader(value, cookieName = PRIVATE_COOKIE_NAME) {
  const cookies = Object.create(null);
  if (typeof value !== 'string') return cookies;
  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) continue;
    const raw = part.slice(separator + 1).trim();
    if (Object.hasOwn(cookies, name)) { cookies[name] = undefined; continue; }
    try { cookies[name] = decodeURIComponent(raw); } catch (_error) { cookies[name] = undefined; }
  }
  return cookies;
}

function serializeCookie(name, token, secure, maxAgeSeconds) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError('serializeSessionCookie requires an opaque session token.');
  }
  const age = Number.isFinite(Number(maxAgeSeconds)) ? Math.max(0, Math.trunc(Number(maxAgeSeconds))) : 0;
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Max-Age=${age}`;
}

function serializeLogout(name, secure) {
  return `${name}=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Max-Age=0`;
}

function createBrowserAccessPolicy({ browserAccessMode = PRIVATE_HTTPS, canonicalOrigin,
  canonicalHost, port } = {}) {
  const mode = normalizeBrowserAccessMode(browserAccessMode);
  const parsed = parseCanonicalOrigin(canonicalOrigin, mode, port);
  if (canonicalHost !== undefined && canonicalHost !== parsed.host) {
    invalid('canonicalHost must match canonicalOrigin.');
  }
  const secure = mode === PRIVATE_HTTPS;
  const cookieName = secure ? PRIVATE_COOKIE_NAME : LOCALHOST_COOKIE_NAME;
  return Object.freeze({
    browserAccessMode: mode,
    canonicalOrigin: parsed.origin,
    canonicalHost: parsed.host,
    port: parsed.port,
    cookieName,
    secure,
    parseCookieHeader: (value) => parseCookieHeader(value, cookieName),
    serializeSessionCookie: (token, options = {}) => serializeCookie(cookieName, token, secure, options.maxAgeSeconds ?? 30 * 24 * 60 * 60),
    serializeLogoutCookie: () => serializeLogout(cookieName, secure),
  });
}

const DEFAULT_PRIVATE_POLICY = createBrowserAccessPolicy({
  browserAccessMode: PRIVATE_HTTPS,
  canonicalOrigin: 'https://jenny.invalid',
});

module.exports = {
  BROWSER_ACCESS_MODES,
  PRIVATE_HTTPS,
  LOCALHOST_HTTP,
  PRIVATE_COOKIE_NAME,
  LOCALHOST_COOKIE_NAME,
  createBrowserAccessPolicy,
  normalizeBrowserAccessMode,
  parseCanonicalOrigin,
  parseCookieHeader: (value) => DEFAULT_PRIVATE_POLICY.parseCookieHeader(value),
  serializeSessionCookie: (token, options) => DEFAULT_PRIVATE_POLICY.serializeSessionCookie(token, options),
  serializeLogoutCookie: () => DEFAULT_PRIVATE_POLICY.serializeLogoutCookie(),
};
