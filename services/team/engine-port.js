'use strict';

// The member-side team engine port (row 123, slice 4b; TEAM_NODE_PROTOCOL_SPEC
// "Team engine (N10)"). A small OpenAI-compatible server on 127.0.0.1 that the
// member's own sidecar calls as an ordinary `openai-compatible` engine; each
// admitted request goes to the injected `forward`, which carries it over the
// authenticated team connection to the host's engine routes. The sidecar gains
// no team knowledge. Every request needs the per-launch key, the exact loopback
// Host and no Origin, all checked before a body byte is read. The answer is
// relayed byte for byte with backpressure: nothing is parsed, stored, retried or
// replayed. Logs carry event names, states, reasons and counts only: never a key,
// a body, a reply, a port or an address.
//
// Per-conversation engine key: `markTurn(tag)` (or `turnRoute.acquire({ sessionId })`)
// gives a turn token for the sidecar's existing route-token header; a request with a
// live token is forwarded with HMAC(per-launch secret, tag) as its engine key, one key
// per tag for the life of the port. No token means the port's key. Only a token's hash
// is held, at most MAX_TURNS at once; tokens and tags are never logged.

const crypto = require('node:crypto');
const http = require('node:http');
const { Readable, pipeline } = require('node:stream');

const { ROUTE_TOKEN_HEADER } = require('../../server/team/pool-gateway');
const { isPrintable } = require('../../server/team/scheduler/state');
const { safeLogger } = require('../../server/team/safe-logger');
// The host engine route's cap (spec N10), one definition for services/team.
const { MAX_STREAM_REQUEST_BYTES: MAX_BODY_BYTES } = require('./http-client');

const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES,
  maxConcurrent: 4,
  headersTimeoutMs: 10_000,
  // Socket silence in both directions. A streamed turn writes queue comments every
  // 15 s; a non-streamed one stays silent until its answer, hence the long default.
  idleTimeoutMs: 15 * 60_000,
});
const LIMIT_MAX = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES, maxConcurrent: 16, headersTimeoutMs: 60_000, idleTimeoutMs: 60 * 60_000,
});
const KEY_BYTES = 32;
const MAX_TURNS = 64; // live turn tokens; a backend runs at most 16 turns at once
const MAX_TAG_LENGTH = 256;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ENGINE_KEY_LABEL = 'jenny-team-engine-key-v1\0';
const MAX_AUTHORIZATION = 512;
const REASON = /^[a-z][a-z0-9_]{0,63}$/u;
const PASSED_HEADERS = ['content-type', 'cache-control'];
const ROUTES = Object.freeze({ 'POST /v1/chat/completions': 'chat', 'GET /v1/models': 'models' });
// R16-F04: a failed team turn is never replayed. The member's sidecar retries a provider answer whose
// status is 5xx, 408, 409, 425 or 429 (sidecar/ai/engines/provider_http.py is_retryable_http_status;
// tests/team-engine.test.js reads that table from the sidecar), and each retry would be a new lease and
// job on the team. A chat answer with such a status goes out as 424 with its reason unchanged.
const NO_RETRY_STATUS = 424;
const SIDECAR_RETRIED_4XX = Object.freeze(new Set([408, 409, 425, 429]));
const answerStatus = (route, status) => (route === 'chat' && (status >= 500 || SIDECAR_RETRIED_4XX.has(status))
  ? NO_RETRY_STATUS : status);

function resolveLimits(overrides = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new RangeError(`Unknown engine port limit ${name}.`);
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_MAX[name]) {
      throw new RangeError(`Engine port limit ${name} must be an integer from 1 to ${LIMIT_MAX[name]}.`);
    }
    out[name] = value;
  }
  return Object.freeze(out);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

function drawKey(randomBytes) {
  const bytes = Buffer.from(randomBytes(KEY_BYTES));
  if (bytes.length !== KEY_BYTES) throw new TypeError('randomBytes must return 32 bytes.');
  const key = bytes.toString('base64url');
  bytes.fill(0);
  return key;
}

// An OpenAI-shaped error that carries the reason and nothing else.
function errorPayload(reason) {
  return Buffer.from(JSON.stringify({ error: { message: reason, type: 'team_engine_error', code: reason } }));
}

function upstreamReason(error) {
  const reason = typeof error?.reason === 'string' ? error.reason : '';
  return REASON.test(reason) ? reason : 'team_engine_unreachable';
}

function closeUpstream(upstream) {
  try { upstream?.close?.(); } catch (_error) { /* already gone */ }
}

// Reads the admitted body into memory, at most `max` bytes. Past the cap nothing more is
// kept, but the rest is drained so the caller can read the 413: answering while it still
// sends makes Node close on unread data, which on Windows resets the connection and loses
// the answer (the pool gateway's rule). Past twice the cap the socket is cut.
function readBody(request, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total <= max) { chunks.push(chunk); return; }
      chunks.length = 0;
      if (total > 2 * max) { settle({ ok: false, reason: 'aborted' }); request.destroy(); }
    });
    request.on('end', () => settle(total > max ? { ok: false, reason: 'too_large' } : { ok: true, body: Buffer.concat(chunks) }));
    request.on('error', () => settle({ ok: false, reason: 'aborted' }));
    request.on('close', () => settle({ ok: false, reason: 'aborted' }));
  });
}

function createTeamEnginePort({ forward, randomBytes = crypto.randomBytes, logger, limits: overrides } = {}) {
  if (typeof forward !== 'function') throw new TypeError('Team engine port requires a forward function.');
  if (typeof randomBytes !== 'function') throw new TypeError('Team engine port requires randomBytes.');
  const limits = resolveLimits(overrides);
  const log = safeLogger(logger);
  const sockets = new Set(); // bounded by server.maxConnections
  const headerTimers = new Map(); // socket -> timer until its request head arrives
  const upstreams = new Set(); // one per admitted request until its caller socket closes
  let server = null;
  let starting = null;
  let closing = null;
  let port = 0;
  let apiKey = '';
  let keyDigest = null;
  let engineKey = '';
  let active = 0;
  const turns = new Map(); // SHA-256 hex of a live turn token -> its tag; never the token itself

  // The tag's engine key: 32 bytes of HMAC-SHA256 under the per-launch secret, as unpadded base64url.
  function engineKeyFor(tag) {
    return crypto.createHmac('sha256', engineKey).update(`${ENGINE_KEY_LABEL}${tag}`, 'utf8').digest('base64url');
  }

  // A turn of the conversation `tag`: a route token for the turn's chat.send and its once-only release.
  function markTurn(tag) {
    if (!server) throw Object.assign(new Error('team_engine_stopped'), { reason: 'team_engine_stopped' });
    if (!isPrintable(tag, MAX_TAG_LENGTH)) {
      throw Object.assign(new Error('team_engine_tag_invalid'), { reason: 'team_engine_tag_invalid' });
    }
    if (turns.size >= MAX_TURNS) throw Object.assign(new Error('team_engine_busy'), { reason: 'team_engine_busy' });
    const token = drawKey(randomBytes);
    const digest = sha256(token).toString('hex');
    turns.set(digest, tag);
    let released = false;
    return { token, release() { if (!released) { released = true; turns.delete(digest); } } };
  }

  // The engine key for a request: the tag's when it carries a live token, the port's one key
  // without a token, null (refused) for a token that is malformed, released or never issued.
  function requestEngineKey(header) {
    if (header === undefined) return engineKey;
    if (typeof header !== 'string' || !TOKEN.test(header)) return null;
    const tag = turns.get(sha256(header).toString('hex'));
    return tag === undefined ? null : engineKeyFor(tag);
  }

  function keyMatches(header) {
    if (!keyDigest) return false;
    const wellFormed = typeof header === 'string' && header.length <= MAX_AUTHORIZATION && header.startsWith('Bearer ');
    const candidate = sha256(wellFormed ? header.slice(7) : '');
    return crypto.timingSafeEqual(candidate, keyDigest) && wellFormed;
  }

  function clearHeaderTimer(socket) {
    const timer = headerTimers.get(socket);
    if (timer) { clearTimeout(timer); headerTimers.delete(socket); }
  }

  function sendError(response, status, reason) {
    const payload = errorPayload(reason);
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length, connection: 'close' });
    response.end(payload);
  }

  function refuse(response, status, reason) {
    sendError(response, status, reason);
    log('info', 'team.engine_port.refused', { status, reason });
  }

  function onConnection(socket) {
    sockets.add(socket);
    const timer = setTimeout(() => { headerTimers.delete(socket); socket.destroy(); }, limits.headersTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    headerTimers.set(socket, timer);
    socket.once('close', () => { clearHeaderTimer(socket); sockets.delete(socket); });
  }

  function onRequest(request, response) {
    clearHeaderTimer(request.socket);
    // Checks in the contract's order, each before any body byte is read and before forward.
    if (request.headers.host !== `127.0.0.1:${port}`) { refuse(response, 403, 'team_engine_host_refused'); return; }
    if (Object.hasOwn(request.headers, 'origin')) { refuse(response, 403, 'team_engine_origin_refused'); return; }
    if (!keyMatches(request.headers.authorization)) { refuse(response, 401, 'team_engine_key_refused'); return; }
    const route = ROUTES[`${request.method} ${request.url}`];
    if (!route) { refuse(response, 404, 'team_engine_not_found'); return; }
    const requestKey = requestEngineKey(request.headers[ROUTE_TOKEN_HEADER]);
    if (requestKey === null) { refuse(response, 403, 'team_engine_route_refused'); return; }
    // Over twice the cap is refused unread; a smaller excess is drained in readBody, then refused.
    const declared = Number(request.headers['content-length']);
    if (route === 'chat' && Number.isFinite(declared) && declared > 2 * limits.maxBodyBytes) {
      refuse(response, 413, 'team_engine_request_too_large');
      return;
    }
    if (active >= limits.maxConcurrent) { refuse(response, answerStatus(route, 503), 'team_engine_busy'); return; }
    admit(request, response, route, requestKey);
  }

  // Any throw past admission ends the caller's answer and its upstream, never a held slot.
  function admit(request, response, route, requestKey) {
    const handle = { controller: new AbortController(), upstream: null, engineKey: requestKey };
    serve(request, response, route, handle).catch(() => {
      log('warn', 'team.engine_port.request_failed', { route, reason: 'internal_error' });
      closeUpstream(handle.upstream);
      response.destroy();
    });
  }

  async function serve(request, response, route, handle) {
    active += 1;
    upstreams.add(handle);
    let outcome = 'caller_closed';
    // The caller's socket closing for any reason ends the upstream request: a cancel severs.
    response.once('close', () => {
      active -= 1;
      upstreams.delete(handle);
      handle.controller.abort();
      closeUpstream(handle.upstream);
      // The close event can come before the pipeline's callback: a relayed answer is
      // complete exactly when the caller's response finished.
      if (outcome === 'streaming') outcome = response.writableFinished ? 'complete' : 'truncated';
      log('info', 'team.engine_port.request', { route, status: response.statusCode, outcome });
    });
    let body = null;
    if (route === 'chat') {
      const read = await readBody(request, limits.maxBodyBytes);
      if (!read.ok) {
        if (read.reason === 'too_large' && !response.headersSent && !response.destroyed) {
          outcome = 'refused';
          sendError(response, 413, 'team_engine_request_too_large');
        }
        return;
      }
      body = read.body;
    }
    if (handle.controller.signal.aborted) return;
    let upstream;
    try {
      upstream = await forward({ route, body, engineKey: handle.engineKey, signal: handle.controller.signal });
    } catch (error) {
      if (handle.controller.signal.aborted) return;
      outcome = 'upstream_failed';
      sendError(response, answerStatus(route, 502), upstreamReason(error));
      return;
    }
    if (handle.controller.signal.aborted) { closeUpstream(upstream); return; }
    handle.upstream = upstream;
    relay(response, upstream, route, (value) => { outcome = value; });
  }

  function relay(response, upstream, route, setOutcome) {
    const status = upstream?.status;
    if (!Number.isInteger(status) || status < 200 || status > 599 || !(upstream?.body instanceof Readable)) {
      setOutcome('upstream_invalid');
      sendError(response, answerStatus(route, 502), 'team_engine_answer_invalid');
      return;
    }
    const headers = { connection: 'close' };
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers?.[name];
      if (typeof value === 'string') headers[name] = value;
    }
    try {
      response.writeHead(answerStatus(route, status), headers);
      // The caller sees the head when the host answers, not at the first body byte.
      response.flushHeaders();
    } catch (_error) {
      setOutcome('upstream_invalid');
      sendError(response, answerStatus(route, 502), 'team_engine_answer_invalid');
      return;
    }
    setOutcome('streaming');
    // Bytes as they come, with backpressure. A failure on either side destroys both
    // ends, so a mid-stream upstream failure reaches the caller as a truncated answer.
    pipeline(upstream.body, response, (error) => { setOutcome(error ? 'truncated' : 'complete'); });
  }

  async function start() {
    if (closing) await closing;
    if (server) return;
    if (starting) { await starting; return; }
    starting = (async () => {
      apiKey = drawKey(randomBytes);
      engineKey = drawKey(randomBytes);
      keyDigest = sha256(apiKey);
      const created = http.createServer({ requestTimeout: 0, headersTimeout: limits.headersTimeoutMs });
      created.maxConnections = limits.maxConcurrent * 2 + 4;
      created.timeout = limits.idleTimeoutMs;
      created.on('timeout', (socket) => socket.destroy());
      created.on('connection', onConnection);
      created.on('request', onRequest);
      // With this listener Node sends no `100 Continue`; the sidecar never sends Expect.
      created.on('checkContinue', (_request, response) => refuse(response, 417, 'team_engine_expect_refused'));
      try {
        await new Promise((resolve, reject) => {
          created.once('error', reject);
          created.listen(0, '127.0.0.1', () => { created.off('error', reject); resolve(); });
        });
      } catch (error) {
        forget();
        log('warn', 'team.engine_port.start_failed', { reason: 'listen_failed' });
        throw error;
      }
      created.on('error', () => {});
      server = created;
      port = created.address().port;
      log('info', 'team.engine_port.started', { state: 'ready' });
    })();
    try { await starting; } finally { starting = null; }
  }

  function forget() {
    apiKey = '';
    engineKey = '';
    turns.clear();
    keyDigest = null;
    port = 0;
  }

  async function stop() {
    // A start still listening finishes first, so the server it makes is the one closed here.
    if (starting) await starting.catch(() => {});
    if (closing) return closing;
    if (!server) { forget(); return Promise.resolve(); }
    const current = server;
    server = null;
    forget();
    const severed = upstreams.size;
    for (const handle of upstreams) { handle.controller.abort(); closeUpstream(handle.upstream); }
    upstreams.clear();
    for (const timer of headerTimers.values()) clearTimeout(timer);
    headerTimers.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    closing = new Promise((resolve) => { current.close(() => resolve()); }).then(() => {
      closing = null;
      log('info', 'team.engine_port.stopped', { state: 'stopped', severed });
    });
    return closing;
  }

  return {
    start,
    stop,
    getBaseUrl: () => (server ? `http://127.0.0.1:${port}/v1` : ''),
    getApiKey: () => (server ? apiKey : ''),
    getStatus: () => ({ state: server ? 'ready' : 'stopped', alias: '' }),
    markTurn,
    // A backend's turn route (services/backend/turn-route.js): the conversation id is the tag.
    turnRoute: Object.freeze({ acquire: async ({ sessionId } = {}) => markTurn(sessionId) }),
    resources: () => ({
      listening: Boolean(server?.listening), sockets: sockets.size, upstreams: upstreams.size, timers: headerTimers.size,
      turns: turns.size,
    }),
  };
}

module.exports = { createTeamEnginePort };
