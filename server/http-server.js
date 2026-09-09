'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequestSecurity } = require('./request-security');
const { ERROR_CODES, hostFailure } = require('./api-contract');
const { DEFAULT_RESOURCE_LIMITS } = require('./config');
const { SUPPORTED_TAGS } = require('../renderer/shared/i18n-utils');

const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
});
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function headers(response, requestId) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', CSP);
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('X-Request-Id', requestId);
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

const HTTP_STATUS = Object.freeze({ invalid: 400, unauthorized: 401, forbidden: 403,
  conflict: 409, limit: 429, persistence: 503, unavailable: 503 });
const STATUS_BY_CODE = Object.fromEntries(Object.entries(ERROR_CODES)
  .map(([kind, code]) => [code, HTTP_STATUS[kind]]));

function failure(response, kind, reason, requestId) {
  const status = HTTP_STATUS[kind] || 503;
  json(response, status, hostFailure(kind, reason, requestId));
}

function authFailure(response, result, requestId) {
  const code = String(result?.code || '');
  const kind = /ORIGIN|HOST|CSRF/.test(code) ? 'forbidden'
    : /RATE|BUSY|LARGE/.test(code) ? 'limit'
      : /UNAVAILABLE|STORE/.test(code) ? 'unavailable' : 'unauthorized';
  failure(response, kind, kind === 'unavailable' ? 'authentication_unavailable' : 'authentication_failed', requestId);
}

async function readJson(request, security, maximum = security.maxBodyBytes) {
  if (String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('json_required');
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('body_limit');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new Error('body_limit');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const parsed = security.parseJsonBody(body);
  if (!parsed.ok) throw new Error('invalid_json');
  return { body, value: parsed.value };
}

function requireBodyless(request) {
  const declared = request.headers['content-length'];
  const transferEncoding = request.headers['transfer-encoding'];
  if ((declared !== undefined && declared !== '0') || transferEncoding !== undefined) {
    throw new Error('unexpected_body');
  }
}

function publicAuth(result) {
  return { ok: true, csrf_token: result.csrfToken,
    session: { id: result.session.id, created_at: result.session.createdAt,
      last_seen_at: result.session.lastSeenAt, expires_at: result.session.expiresAt } };
}

function readStaticAssets(staticRoot) {
  const assets = new Map();
  for (const [url, [name, contentType]] of Object.entries(STATIC_FILES)) {
    const file = path.join(staticRoot, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('invalid_browser_build');
    assets.set(url, { contentType, body: fs.readFileSync(file) });
  }
  const catalogRoot = path.join(staticRoot, 'locales');
  if (fs.existsSync(catalogRoot)) {
    const stat = fs.lstatSync(catalogRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_browser_build');
    for (const tag of [...SUPPORTED_TAGS, 'qps-ploc']) {
      const file = path.join(catalogRoot, `${tag}.json`);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('invalid_browser_build');
      assets.set(`/locales/${tag}.json`, { contentType: 'application/json; charset=utf-8', body: fs.readFileSync(file) });
    }
  }
  return assets;
}

function createHttpServer({ canonicalOrigin, staticRoot, auth, clients, events, router,
  bootEpoch, isReady = () => true, logger = () => {}, assetRoutes = null,
  resourceLimits = DEFAULT_RESOURCE_LIMITS, browserAccessMode = 'private_https',
  executionStatus = () => false }) {
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...resourceLimits };
  const security = createRequestSecurity({ canonicalOrigin, browserAccessMode,
    maxBodyBytes: limits.maxBodyBytes });
  const assets = readStaticAssets(staticRoot);
  const streams = new Map();
  let active = 0;
  let disposed = false;

  function log(level, event, requestId) {
    try { logger(level, event, { request_id: requestId }); } catch { /* logging cannot change authority */ }
  }

  async function dispatch(request, response) {
    const requestId = randomUUID();
    headers(response, requestId);
    if (disposed || active >= limits.maxConcurrentRequests) { failure(response, 'limit', 'request_capacity', requestId); return; }
    active += 1;
    try {
      const checked = security.validateHostAndOrigin(request.headers, request);
      if (!checked.ok) { authFailure(response, checked, requestId); return; }
      if (!request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 2048) {
        failure(response, 'invalid', 'invalid_route', requestId); return;
      }
      const url = new URL(request.url, canonicalOrigin);
      if (url.search) { failure(response, 'invalid', 'query_not_supported', requestId); return; }
      const route = `${request.method} ${url.pathname}`;
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': asset.contentType });
        response.end(asset.body); return;
      }
      if (route === 'GET /healthz') { json(response, 200, { alive: true }); return; }
      if (route === 'GET /readyz') { const ready = isReady(); json(response, ready ? 200 : 503, { ready }); return; }
      if (route === 'POST /api/v1/auth/login') {
        const { body } = await readJson(request, security, 4096);
        const result = await security.login(auth, { method: request.method, headers: request.headers, body,
          rateKey: request.socket.remoteAddress || 'unknown' });
        if (!result.ok) { authFailure(response, result, requestId); return; }
        response.setHeader('Set-Cookie', result.setCookie);
        json(response, 200, publicAuth(result)); return;
      }
      if (route === 'GET /api/v1/bootstrap') {
        const result = await security.bootstrap(auth, request);
        if (!result.ok) { authFailure(response, result, requestId); return; }
        let execution = false;
        try { execution = executionStatus() === true; } catch (_error) { /* fail closed */ }
        json(response, 200, { ...publicAuth(result), api_version: 1, boot_epoch: bootEpoch,
          ready: isReady(), tools: { execution } }); return;
      }
      if (route === 'POST /api/v1/auth/logout') {
        requireBodyless(request);
        const result = await security.logout(auth, request);
        if (!result.ok) { authFailure(response, result, requestId); return; }
        response.setHeader('Set-Cookie', result.clearCookie);
        json(response, 200, { ok: true }); return;
      }
      const identity = request.method === 'GET'
        ? await security.authenticateCookie(auth, request)
        : await security.authorizeMutation(auth, request);
      if (!identity.ok) { authFailure(response, identity, requestId); return; }
      const deviceId = identity.session.id;
      const isAuthenticated = () => !disposed && auth.isSessionActive(deviceId);
      if (!isAuthenticated()) { failure(response, 'unauthorized', 'session_expired', requestId); return; }
      if (route === 'GET /api/v1/auth/sessions') {
        const result = auth.listSessions();
        if (!result.ok) { authFailure(response, result, requestId); return; }
        json(response, 200, { ok: true, sessions: result.sessions.map((session) => ({
          id: session.id, created_at: session.createdAt, last_seen_at: session.lastSeenAt,
          expires_at: session.expiresAt, current: session.id === deviceId,
        })) }); return;
      }
      if (route === 'POST /api/v1/auth/revoke') {
        const { value } = await readJson(request, security, 4096);
        if (!value || Object.keys(value).length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(value.session_id || '')) {
          failure(response, 'invalid', 'invalid_session_reference', requestId); return;
        }
        if (!isAuthenticated()) { failure(response, 'unauthorized', 'session_expired', requestId); return; }
        const result = await auth.revokeSession(value.session_id);
        if (!result.ok) { authFailure(response, result, requestId); return; }
        json(response, 200, { ok: true, revoked: result.revoked }); return;
      }
      if (route === 'POST /api/v1/clients') {
        requireBodyless(request);
        const client = clients.register(deviceId);
        if (!client) { failure(response, 'limit', 'client_capacity', requestId); return; }
        json(response, 200, { ok: true, ...client }); return;
      }
      if (route === 'POST /api/v1/commands') {
        const { value } = await readJson(request, security);
        const result = await router.dispatch(value, { deviceId,
          clientToken: request.headers['x-client-token'], isAuthenticated });
        if (!isAuthenticated()) { failure(response, 'unauthorized', 'session_expired', requestId); return; }
        if (Buffer.byteLength(JSON.stringify(result)) > limits.maxResponseBytes) {
          failure(response, 'limit', 'response_limit', requestId); return;
        }
        json(response, result.ok ? 200 : STATUS_BY_CODE[result.error?.code] || 503, result); return;
      }
      const clientId = request.headers['x-client-id'];
      const clientToken = request.headers['x-client-token'];
      const authorized = () => isAuthenticated() && clients.authorize(clientId, clientToken, deviceId);
      if (!authorized()) { failure(response, 'forbidden', 'client_required', requestId); return; }
      if (route === 'GET /api/v1/events') {
        const detachClient = clients.attach(clientId, clientToken, deviceId);
        if (!detachClient) { failure(response, 'forbidden', 'client_required', requestId); return; }
        const previous = streams.get(clientId);
        if (previous) { previous.unsubscribe(); previous.response.destroy(); }
        const resume = /^([A-Za-z0-9_-]{1,128}):(\d{1,16})$/.exec(request.headers['last-event-id'] || '');
        const unsubscribe = events.subscribe({ response, deviceId, authorized,
          bootEpoch: resume?.[1], cursor: resume ? Number(resume[2]) : -1,
          onAdmit: () => {
            response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive',
              'X-Accel-Buffering': 'no' });
            response.flushHeaders();
          },
          onReject: (kind) => failure(response, kind, 'events_admission_failed', requestId),
        });
        if (!unsubscribe) { detachClient(); return; }
        const entry = { response, unsubscribe, detachClient };
        streams.set(clientId, entry);
        response.once('close', () => {
          unsubscribe();
          detachClient();
          if (streams.get(clientId) === entry) streams.delete(clientId);
        });
        return;
      }
      if (assetRoutes && await assetRoutes({ request, response, pathname: url.pathname,
        deviceId, clientId, authorized, security, requestId })) return;
      json(response, 404, hostFailure('invalid', 'route_not_found', requestId));
    } catch (error) {
      log('WARN', 'host.request_rejected', requestId);
      if (response.headersSent) response.destroy();
      else failure(response, ['json_required', 'invalid_json', 'body_limit', 'unexpected_body'].includes(error.message)
        ? 'invalid' : 'unavailable', 'request_failed', requestId);
    } finally { active -= 1; }
  }

  const server = http.createServer({ maxHeaderSize: limits.maxHeaderBytes, requestTimeout: limits.requestTimeoutMs,
    headersTimeout: Math.min(15_000, limits.requestTimeoutMs), keepAliveTimeout: 5_000 }, (request, response) => { void dispatch(request, response); });
  server.maxRequestsPerSocket = 1000;
  const heartbeat = setInterval(() => events.heartbeat(), 5000);
  heartbeat.unref();
  server.once('close', () => clearInterval(heartbeat));
  const close = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    for (const { response, unsubscribe, detachClient } of streams.values()) {
      unsubscribe(); detachClient(); response.destroy();
    }
    streams.clear();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
    }));
  };
  return { server, close };
}

module.exports = { createHttpServer, readJson, json, requireBodyless };
