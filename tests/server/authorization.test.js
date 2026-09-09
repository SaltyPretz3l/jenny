'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AUTH_COOKIE_NAME,
  createRequestSecurity,
  parseCookieHeader,
  serializeLogoutCookie,
  serializeSessionCookie,
} = require('../../server/request-security');

const ORIGIN = 'https://jenny.example.test';
const HOST = 'jenny.example.test';

function headers(overrides = {}) {
  return { host: HOST, origin: ORIGIN, ...overrides };
}

test('session cookie is host-only, secure, HttpOnly, and strict', () => {
  const cookie = serializeSessionCookie('a'.repeat(43));
  assert.match(cookie, new RegExp(`^${AUTH_COOKIE_NAME}=a{43}`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(parseCookieHeader(cookie)[AUTH_COOKIE_NAME], 'a'.repeat(43));
  assert.match(serializeLogoutCookie(), /Max-Age=0/);
});

test('localhost policy uses an isolated non-secure cookie and never crosses HTTPS mode', () => {
  const localOrigin = 'http://127.0.0.1:8090';
  const local = createRequestSecurity({ canonicalOrigin: localOrigin, browserAccessMode: 'localhost_http' });
  const secure = createRequestSecurity({ canonicalOrigin: ORIGIN });
  const token = 'a'.repeat(43);
  const localCookie = local.serializeSessionCookie(token);
  const secureCookie = secure.serializeSessionCookie(token);
  assert.equal(local.cookieName, 'jenny-localhost');
  assert.match(localCookie, /^jenny-localhost=a{43}; Path=\/; HttpOnly; SameSite=Strict;/);
  assert.doesNotMatch(localCookie, /Secure/);
  assert.equal(local.parseCookieHeader(localCookie)['jenny-localhost'], token);
  assert.equal(local.parseCookieHeader(secureCookie)['jenny-localhost'], undefined);
  assert.equal(secure.parseCookieHeader(localCookie)['__Host-jenny'], undefined);
  assert.equal(local.validateHostAndOrigin({ host: '127.0.0.1:8090' }).ok, true);
  assert.equal(local.validateHostAndOrigin({ host: 'localhost:8090' }).code, 'AUTH_HOST_MISMATCH');
  assert.equal(local.validateHostAndOrigin({ host: '127.0.0.1:8090', origin: 'http://localhost:8090' }, { method: 'POST' }).code, 'AUTH_ORIGIN_MISMATCH');
});

test('origin and host checks are exact and never consult forwarded headers', () => {
  const security = createRequestSecurity({ canonicalOrigin: ORIGIN });
  assert.equal(security.validateHostAndOrigin(headers(), { method: 'GET' }).ok, true);
  assert.equal(security.validateHostAndOrigin({ host: HOST }, { method: 'GET' }).ok, true);
  assert.equal(security.validateHostAndOrigin({ host: HOST }, { method: 'POST' }).code, 'AUTH_ORIGIN_MISMATCH');
  assert.equal(security.validateHostAndOrigin(headers({ origin: 'https://evil.example.test' }), { method: 'POST' }).code, 'AUTH_ORIGIN_MISMATCH');
  assert.equal(security.validateHostAndOrigin(headers({ host: 'evil.example.test', 'x-forwarded-host': HOST }), { method: 'GET' }).code, 'AUTH_HOST_MISMATCH');
  assert.equal(security.validateHostAndOrigin(headers({ 'x-forwarded-origin': ORIGIN, origin: 'https://evil.example.test' }), { method: 'POST' }).code, 'AUTH_ORIGIN_MISMATCH');
  assert.equal(security.validateHostAndOrigin(headers({ 'content-type': 'text/plain' }), { method: 'POST', login: true }).code, 'AUTH_JSON_REQUIRED');
  assert.equal(security.validateHostAndOrigin(headers({ 'content-type': 'application/json; charset=utf-8' }), { method: 'POST', login: true }).ok, true);
});

test('login wrapper requires exact origin and JSON, then returns one cookie', async () => {
  const security = createRequestSecurity({ canonicalOrigin: ORIGIN, maxBodyBytes: 200 });
  const calls = [];
  const authService = {
    async login(input) { calls.push(input); return { ok: true, token: 'b'.repeat(43), csrfToken: 'c'.repeat(43) }; },
  };
  const denied = await security.login(authService, { headers: headers({ origin: 'https://evil.test', 'content-type': 'application/json' }), body: '{}' });
  assert.equal(denied.code, 'AUTH_ORIGIN_MISMATCH');
  const result = await security.login(authService, { headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ password: 'a password' }), rateKey: 'ip-hash' });
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'token'), false);
  assert.equal(calls[0].rateKey, 'ip-hash');
  assert.match(result.setCookie, /HttpOnly/);
});

test('mutations require authentication and CSRF while GET may omit Origin', async () => {
  const security = createRequestSecurity({ canonicalOrigin: ORIGIN });
  const authService = {
    async authenticateCookie(token) { return token === 'd'.repeat(43) ? { ok: true, session: { id: 'session' } } : { ok: false, code: 'AUTH_UNAUTHENTICATED' }; },
    async validateCsrf(token, csrf) { return token === 'd'.repeat(43) && csrf === 'csrf'; },
  };
  const cookie = `${AUTH_COOKIE_NAME}=${'d'.repeat(43)}`;
  const request = { headers: headers({ cookie, 'x-csrf-token': 'csrf' }), method: 'POST' };
  assert.equal((await security.authorizeMutation(authService, request)).ok, true);
  assert.equal((await security.authorizeMutation(authService, { ...request, headers: headers({ cookie }) })).code, 'AUTH_CSRF_INVALID');
  assert.equal((await security.authorizeMutation(authService, { ...request, headers: { host: HOST, cookie, 'x-csrf-token': 'csrf' } })).code, 'AUTH_ORIGIN_MISMATCH');
});

test('bootstrap accepts an absent Origin on a same-origin GET', async () => {
  const security = createRequestSecurity({ canonicalOrigin: ORIGIN });
  const authService = {
    async bootstrap(token) { return { ok: token === 'e'.repeat(43), csrfToken: 'f'.repeat(43), session: { id: 'session' } }; },
  };
  const result = await security.bootstrap(authService, { method: 'GET', headers: { host: HOST, cookie: `${AUTH_COOKIE_NAME}=${'e'.repeat(43)}` } });
  assert.equal(result.ok, true);
});

test('body size is checked before JSON parsing', () => {
  const security = createRequestSecurity({ canonicalOrigin: ORIGIN, maxBodyBytes: 4 });
  assert.equal(security.checkBodySize('12345').code, 'AUTH_BODY_TOO_LARGE');
  assert.equal(security.parseJsonBody('{"a":1}').code, 'AUTH_BODY_TOO_LARGE');
  assert.equal(security.parseJsonBody('{}').ok, true);
});

test('missing, throwing and malformed authentication cannot escape the HTTP edge', async () => {
  const security = createRequestSecurity({ canonicalOrigin: ORIGIN });
  for (const auth of [null, {}, { authenticateCookie() { throw new Error('secret path'); } },
    { authenticateCookie: async () => true }, { authenticateCookie: async () => ({ ok: true }) }]) {
    const result = await security.authenticateCookie(auth, { headers: headers() });
    assert.equal(result.code, 'AUTH_UNAVAILABLE');
  }
  const login = await security.login({ login: async () => ({ ok: true }) }, {
    headers: headers({ 'content-type': 'application/json' }), body: '{"password":"a password"}',
  });
  assert.equal(login.code, 'AUTH_UNAVAILABLE');
  assert.equal(parseCookieHeader(`${AUTH_COOKIE_NAME}=one; ${AUTH_COOKIE_NAME}=two`)[AUTH_COOKIE_NAME], undefined);
});
