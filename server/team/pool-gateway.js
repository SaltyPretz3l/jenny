'use strict';

// The team pool gateway (row 123, slice 4a-2; spec "Pool gateway"). A small
// HTTP server on 127.0.0.1 that the host's own sidecar calls as an ordinary
// OpenAI-compatible engine. Every request needs the per-boot key; chat also
// needs the route token of an active lease. Prompts and replies pass through
// memory only: no request or response text is logged, stored or put in an
// error. Node output is relayed as bytes, never parsed here.

const crypto = require('node:crypto');
const http = require('node:http');

const { hostFailure } = require('../api-contract');
const { safeLogger } = require('./safe-logger');

const POOL_MODEL_ALIAS = 'team-pool';
// Lower-case, as Node presents request headers. Sidecar slice 4a-3 sends
// `X-Jenny-Route-Token`, which HTTP treats as the same name.
const ROUTE_TOKEN_HEADER = 'x-jenny-route-token';

// The body cap is the scheduler's maxRequestBytes, so there is one definition.
const DEFAULT_LIMITS = Object.freeze({
  commentIntervalMs: 15_000,
  maxSockets: 64,
  stopTimeoutMs: 2_000,
  headersTimeoutMs: 10_000,
  contextCap: null, // the owner's configured context cap, or null for none
});
const MIN_BOOT_KEY_LENGTH = 32;
const MAX_HEADER_SECRET = 512;
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);
const THINKING_FIELDS = ['reasoning_effort', 'thinking_budget_tokens'];
const THINKING_TEMPLATE_FIELDS = ['enable_thinking', 'reasoning_effort'];
const THINKING_TEMPLATE = '{%- if enable_thinking is defined -%}{%- endif -%}';
const TIMEOUT_REASONS = new Set(['first_byte_timeout', 'stall_timeout', 'job_timeout', 'job_wait_timeout']);
const SSE_HEADERS = Object.freeze({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json', 'cache-control': 'no-store' });
const JOB_REFUSALS = Object.freeze({
  lease_not_active: [410, 'conflict'], lease_not_found: [410, 'conflict'], lease_busy: [409, 'conflict'],
  job_request_too_large: [413, 'invalid'],
});

function resolveGatewayLimits(overrides = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new RangeError(`Unknown gateway limit ${key}.`);
    if (key === 'contextCap') {
      if (value !== null && !(Number.isSafeInteger(value) && value > 0)) throw new RangeError('Gateway limit contextCap is invalid.');
    } else if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) {
      throw new RangeError(`Gateway limit ${key} must be an integer from 1 to ${DEFAULT_LIMITS[key]}.`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasImagePart(body) {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((message) => isPlainObject(message) && Array.isArray(message.content)
    && message.content.some((part) => isPlainObject(part)
      && (IMAGE_PART_TYPES.has(part.type) || Object.hasOwn(part, 'image_url'))));
}

// Plain top-level field removals for a model that takes no thinking parameters.
function dropThinking(body) {
  for (const field of THINKING_FIELDS) delete body[field];
  if (isPlainObject(body.chat_template_kwargs)) {
    for (const field of THINKING_TEMPLATE_FIELDS) delete body.chat_template_kwargs[field];
  }
}

// Reads the body into memory up to `max` bytes; bytes past the cap are counted
// and discarded, never buffered. A declared length over twice the cap is refused
// at once without reading, and the socket closes after the answer. A smaller
// oversized body is drained first, so the client can read the 413: answering
// while it still sends makes Node close on unread data, which on Windows resets
// the connection and loses the answer. An undeclared body that passes twice the
// cap closes the socket.
function readBody(request, max) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > 2 * max) return Promise.resolve({ ok: false, reason: 'too_large' });
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total <= max) chunks.push(chunk);
      else if (total > 2 * max) { settle({ ok: false, reason: 'too_large', closed: true }); request.destroy(); }
    });
    request.on('end', () => settle(total > max ? { ok: false, reason: 'too_large' } : { ok: true, body: Buffer.concat(chunks) }));
    request.on('error', () => settle({ ok: false, reason: 'aborted', closed: true }));
    request.on('close', () => settle({ ok: false, reason: 'aborted', closed: true }));
  });
}

function createPoolGateway({ scheduler, bootKey, clock = Date.now, logger, limits: overrides } = {}) {
  if (!scheduler || typeof scheduler.resolveToken !== 'function' || !Number.isSafeInteger(scheduler.limits?.maxRequestBytes)) {
    throw new TypeError('Pool gateway requires a scheduler.');
  }
  if (typeof bootKey !== 'string' || bootKey.length < MIN_BOOT_KEY_LENGTH || bootKey.length > MAX_HEADER_SECRET) {
    throw new TypeError('Pool gateway requires a boot key of at least 32 characters.');
  }
  const limits = resolveGatewayLimits(overrides);
  const maxRequestBytes = scheduler.limits.maxRequestBytes;
  const log = safeLogger(logger);
  const keyDigest = sha256(bootKey);
  const sockets = new Set(); // bounded by server.maxConnections
  const timers = new Set(); // one comment timer per waiting stream
  let server = null;
  let port = 0;

  function keyMatches(header) {
    const wellFormed = typeof header === 'string' && header.length <= MAX_HEADER_SECRET && header.startsWith('Bearer ');
    const candidate = sha256(wellFormed ? header.slice(7) : '');
    return crypto.timingSafeEqual(candidate, keyDigest) && wellFormed;
  }

  function sendJson(response, status, body, { close = false } = {}) {
    const payload = Buffer.from(JSON.stringify(body));
    response.writeHead(status, { ...JSON_HEADERS, 'content-length': payload.length, ...(close ? { connection: 'close' } : {}) });
    response.end(payload);
  }

  function refuse(context, status, kind, reason) {
    context.request.resume();
    sendJson(context.response, status, hostFailure(kind, reason), { close: true });
    log('info', 'team.pool.gateway.refused', { route: context.route, status, reason, duration_ms: clock() - context.started });
  }

  function notFound(context) {
    context.request.resume();
    context.response.writeHead(404, { 'content-length': 0, connection: 'close' });
    context.response.end();
    log('info', 'team.pool.gateway.refused', { route: 'other', status: 404, duration_ms: clock() - context.started });
  }

  function serveModels(context) {
    sendJson(context.response, 200, {
      object: 'list', data: [{ id: POOL_MODEL_ALIAS, object: 'model', created: 0, owned_by: 'team' }],
    });
  }

  function serveProps(context) {
    const summary = scheduler.poolSummary();
    const lengths = [summary.context_length, limits.contextCap].filter((n) => Number.isSafeInteger(n));
    const props = { modalities: { vision: summary.vision === true } };
    if (lengths.length) props.default_generation_settings = { n_ctx: Math.min(...lengths) };
    if (summary.thinking) {
      props.chat_template_caps = { supports_reasoning_effort: true };
      props.chat_template = THINKING_TEMPLATE;
    }
    sendJson(context.response, 200, props);
  }

  async function serveChat(context, lease) {
    const read = await readBody(context.request, maxRequestBytes);
    if (!read.ok) {
      if (read.reason === 'too_large' && !read.closed) refuse(context, 413, 'invalid', 'job_request_too_large');
      else if (!context.response.headersSent) context.response.destroy();
      return;
    }
    let body;
    try { body = JSON.parse(read.body.toString('utf8')); } catch (_error) { body = null; }
    if (!isPlainObject(body)) { refuse(context, 400, 'invalid', 'request_body_invalid'); return; }
    const info = lease.model_info || { vision: false, thinking: false };
    if (info.vision !== true && hasImagePart(body)) { refuse(context, 400, 'invalid', 'model_lacks_vision'); return; }
    if (info.thinking !== true) dropThinking(body);
    body.model = lease.model;
    const stream = body.stream === true;
    const created = scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from(JSON.stringify(body)), stream });
    if (!created.ok) {
      const reason = created.error.reason;
      const [status, kind] = JOB_REFUSALS[reason] || [503, 'unavailable'];
      refuse(context, status, kind, reason);
      return;
    }
    relay(context, lease, created.job, stream);
  }

  // Relays one job. A stream job answers 200 event-stream at once, with comment
  // lines until the first data; a non-stream job answers only when its first
  // bytes or its end arrive, so a failure before any byte gets a real status.
  function relay(context, lease, job, stream) {
    const { response } = context;
    let relayed = 0;
    let finished = false;
    let timer = null;
    const stopTimer = () => { if (timer) { clearInterval(timer); timers.delete(timer); timer = null; } };
    const logDone = (outcome) => {
      log('info', 'team.pool.gateway.request', { route: context.route, status: response.statusCode,
        lease_id: lease.lease_id, job_id: job.job_id, stream, request_bytes: job.request_bytes,
        response_bytes: relayed, outcome, duration_ms: clock() - context.started });
    };
    const unwatch = scheduler.watchJob(job.job_id, onEvent);
    if (!unwatch) {
      scheduler.cancelJob(job.job_id);
      refuse(context, 503, 'unavailable', 'host_unavailable');
      return;
    }
    if (stream) {
      response.writeHead(200, SSE_HEADERS);
      response.flushHeaders();
      timer = setInterval(() => { if (relayed === 0) response.write(': keepalive\n\n'); }, limits.commentIntervalMs);
      timers.add(timer);
    }
    response.on('close', () => {
      stopTimer();
      unwatch();
      if (finished) return;
      finished = true;
      scheduler.cancelJob(job.job_id);
      logDone('request_closed');
    });

    function onEvent(event) {
      if (finished) return;
      if (event.type === 'data') {
        stopTimer();
        if (!response.headersSent) response.writeHead(200, JSON_HEADERS);
        relayed += event.bytes.length;
        response.write(event.bytes);
        return;
      }
      finished = true;
      stopTimer();
      if (event.state === 'done') {
        if (!response.headersSent) response.writeHead(200, JSON_HEADERS);
        response.end();
      } else if (relayed > 0) {
        response.destroy();
      } else {
        const failure = hostFailure('unavailable', event.reason || 'host_unavailable');
        if (stream) {
          const frame = { error: { message: 'The pool job did not complete.', type: 'pool_error',
            code: failure.error.code, reason: failure.error.reason } };
          response.end(`data: ${JSON.stringify(frame)}\n\n`);
        } else {
          sendJson(response, TIMEOUT_REASONS.has(failure.error.reason) ? 504 : 502, failure);
        }
      }
      logDone(event.reason || event.state);
    }
  }

  async function handle(request, response) {
    const context = { request, response, started: clock(), route: 'other' };
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${port}`) {
      refuse(context, 403, 'forbidden', 'request_origin_forbidden');
      return;
    }
    const route = `${request.method} ${request.url}`;
    if (route !== 'POST /v1/chat/completions' && route !== 'GET /v1/models' && route !== 'GET /props') {
      notFound(context);
      return;
    }
    context.route = route;
    const keyOk = keyMatches(request.headers.authorization);
    if (route !== 'POST /v1/chat/completions') {
      if (!keyOk) { refuse(context, 401, 'unauthorized', 'route_token_required'); return; }
      request.resume();
      if (route === 'GET /v1/models') serveModels(context); else serveProps(context);
      return;
    }
    const tokenHeader = request.headers[ROUTE_TOKEN_HEADER];
    const resolved = scheduler.resolveToken(typeof tokenHeader === 'string' ? tokenHeader : '');
    if (!keyOk || !resolved) { refuse(context, 401, 'unauthorized', 'route_token_required'); return; }
    if (resolved.status !== 'active') { refuse(context, 410, 'conflict', 'lease_not_active'); return; }
    await serveChat(context, resolved.lease);
  }

  function start() {
    if (server) return Promise.reject(new Error('Pool gateway already started.'));
    const candidate = http.createServer((request, response) => {
      handle(request, response).catch(() => {
        log('warn', 'team.pool.gateway.failed', {});
        response.destroy();
      });
    });
    candidate.maxConnections = limits.maxSockets;
    candidate.headersTimeout = limits.headersTimeoutMs;
    candidate.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server = candidate;
    return new Promise((resolve, reject) => {
      const onListenError = (error) => {
        if (server === candidate) server = null;
        reject(error);
      };
      candidate.once('error', onListenError);
      candidate.listen(0, '127.0.0.1', () => {
        candidate.off('error', onListenError);
        candidate.on('error', () => log('warn', 'team.pool.gateway.server_error', {}));
        port = candidate.address().port;
        resolve(port);
      });
    });
  }

  async function stop() {
    if (!server) return;
    const closing = server;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    const closed = new Promise((resolve) => { closing.close(() => resolve()); });
    closing.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    let bound = null;
    await Promise.race([closed, new Promise((resolve) => { bound = setTimeout(resolve, limits.stopTimeoutMs); })]);
    clearTimeout(bound);
    sockets.clear();
    server = null;
  }

  function resources() {
    return { listening: Boolean(server && server.listening), sockets: sockets.size, timers: timers.size };
  }

  return Object.freeze({ start, stop, resources, port: () => port });
}

module.exports = { POOL_MODEL_ALIAS, ROUTE_TOKEN_HEADER, createPoolGateway };
