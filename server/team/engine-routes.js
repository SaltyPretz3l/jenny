'use strict';

// The team engine host routes (row 123, slice 4b; node protocol spec "Team engine
// (N10)"). A member's own Jenny uses the team's pooled GPUs as an inference
// engine for that member's private conversations, through its loopback engine
// port (`services/team/engine-port.js`), which relays these answers untouched:
//
//   POST /api/v1/team/engine/v1/chat/completions   one job on a lease with no
//        conversation, the node's stream relayed as bytes
//   GET  /api/v1/team/engine/v1/models             the union of online models
//
// A raw-route handler of the host's `assetRoutes` shape: (context) => true when
// the path is one of the two routes (handled), false otherwise. Every request
// passes the client binding and the one guard with `engine.use` before the body
// is read, again after each await that precedes the job, and at most once a
// second while the job streams. A missing actor, guard or client binding, or a
// guard that throws, is a refusal.
//
// No content at rest or in logs: the prompt lives in memory until the job takes
// it, as its raw bytes while the request waits for a lease (it is parsed to admit
// it and again once the lease is granted); of the reply only the last 8 KiB is
// held, to read the final `usage` chunk, and dropped when the request ends. Log
// lines, error bodies and the usage log carry ids, reason codes, counts and
// durations only; never a body, a header value or the engine key. A failed turn is
// never retried or replayed.
//
// What the node reads is never the caller's object: it is rebuilt from a lowercase allowlist of chat fields
// (engine-request-fields.js) before the image check, the thinking fit and the stream flag, and a case variant of
// an allowed key is refused. A revoked or demoted member's request ends at the next membership recheck (the
// pool's `onRecheck`), on each streaming comment tick and on each data event.
//
// An answer counts against its member and in resources() until it has flushed or
// its socket closed; one whose reader stops taking bytes is destroyed after the
// host's response write deadline, and any is destroyed after a fixed number of them.

const { hostFailure } = require('../api-contract');
const { RESPONSE_WRITE_TIMEOUT_MS, STATUS_BY_CODE } = require('../http-server');
const { isId } = require('./ids');
const { canonicalChatBody } = require('./engine-request-fields');
const { ENGINE_KEY_PATTERN } = require('./pool-composition');
const {
  COMMENT_INTERVAL_MS, JSON_HEADERS, SSE_HEADERS, TIMEOUT_REASONS, fitThinking, hasImagePart, isPlainObject, readBody,
} = require('./pool-gateway');
const { routeDenial } = require('./route-guard');
const { safeLogger } = require('./safe-logger');
const { REASON_PATTERN } = require('./usage-log');

const CHAT_ROUTE = 'POST /api/v1/team/engine/v1/chat/completions';
const MODELS_ROUTE = 'GET /api/v1/team/engine/v1/models';
const ENGINE_ACTION = 'engine.use';
const TEAM_RESOURCE = Object.freeze({ kind: 'team', id: '' });
const ENGINE_KEY_HEADER = 'x-engine-key';
const TAIL_BYTES = 8 * 1024;
const RECHECK_MS = 1000; // how often a streaming job re-runs the guard
const MAX_BODY_BYTES = 8 * 1024 * 1024; // spec N10: the engine route's own cap, the scheduler's maxRequestBytes
const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES,
  maxPerMember: 2, // engine requests one member may hold at once (the spec is silent); one of them non-streamed
  maxBufferedBytes: 1024 * 1024, // reply bytes held for a client that stops reading, then client_stalled
  commentIntervalMs: COMMENT_INTERVAL_MS,
  // How long an ended answer may go without a byte leaving before it is destroyed: the host's own deadline.
  responseWriteTimeoutMs: RESPONSE_WRITE_TIMEOUT_MS,
  // How many of those deadlines an ended answer may take in all, however its bytes move.
  maxFlushDeadlines: 5,
});
// Statuses that differ from the error kind's: an OpenAI-style client reads a missing
// model as missing, an unavailable pool as unavailable, a vision refusal and an
// oversized job as the request's fault, and a queue wait that ran out as a timeout.
const REASON_STATUS = Object.freeze({
  model_lacks_vision: 400, model_not_in_pool: 404, job_request_too_large: 413, no_eligible_node: 503,
  queue_timeout: 504,
});
const NO_USAGE = Object.freeze({ prompt: null, completion: null });

function resolveLimits(overrides = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new RangeError(`Unknown engine limit ${key}.`);
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) {
      throw new RangeError(`Engine limit ${key} must be an integer from 1 to ${DEFAULT_LIMITS[key]}.`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

const reasonOf = (value) => (typeof value === 'string' && REASON_PATTERN.test(value) ? value : 'host_unavailable');
const statusFor = (reason, code) => REASON_STATUS[reason] ?? STATUS_BY_CODE[code] ?? 503;

// The member engine port's error shape: the reason and nothing else.
function errorPayload(reason) {
  return { error: { message: reason, type: 'team_engine_error', code: reason } };
}

// Reads prompt and completion tokens from the last `"usage": {` object in the
// held tail. JSON escapes every quote inside a string value, so only structural
// keys match. Digits only: nothing else is read out of the reply.
function readUsage(tail) {
  if (!tail || tail.length === 0) return NO_USAGE;
  const text = tail.toString('latin1');
  const opener = /"usage"\s*:\s*\{/gu;
  let start = -1;
  for (let match = opener.exec(text); match; match = opener.exec(text)) start = match.index + match[0].length;
  if (start < 0) return NO_USAGE;
  const rest = text.slice(start);
  const count = (key) => {
    const found = new RegExp(`"${key}"\\s*:\\s*(\\d{1,15})`, 'u').exec(rest);
    const value = found ? Number(found[1]) : null;
    return Number.isSafeInteger(value) ? value : null;
  };
  return { prompt: count('prompt_tokens'), completion: count('completion_tokens') };
}

function keepTail(record, bytes) {
  if (bytes.length >= TAIL_BYTES) { record.tail = Buffer.from(bytes.subarray(bytes.length - TAIL_BYTES)); return; }
  const joined = Buffer.concat([record.tail, bytes]);
  record.tail = joined.length > TAIL_BYTES ? Buffer.from(joined.subarray(joined.length - TAIL_BYTES)) : joined;
}

// The client binding is a function the HTTP layer re-evaluates on every call; a
// value that is not a function is never accepted.
function clientBound(ctx) {
  try {
    return typeof ctx.authorized === 'function' && ctx.authorized() === true;
  } catch (_error) {
    return false;
  }
}

// null when a member's raw team route may do `action` on `resource`, else a
// hostFailure: a registered client, an actor, the guard (run on every call) and a
// member id from the actor the HTTP layer resolved. Shared with node-routes.js.
function memberRouteDenial(ctx, action, resource) {
  if (!clientBound(ctx)) return hostFailure('forbidden', 'client_required');
  if (!ctx.actor || typeof ctx.actor !== 'object') return hostFailure('forbidden', 'role_forbidden');
  const denied = routeDenial(ctx, action, resource, { guardRequired: true });
  if (denied) return denied;
  return isId('member', ctx.actor.member_id) ? null : hostFailure('forbidden', 'role_forbidden');
}

const engineDenial = (ctx) => memberRouteDenial(ctx, ENGINE_ACTION, TEAM_RESOURCE);

function createEngineRoutes({ pool = null, usageLog, clock = Date.now, logger, limits: overrides } = {}) {
  if (pool !== null && (typeof pool?.engineRoute?.acquire !== 'function' || !pool.scheduler)) {
    throw new TypeError('Engine routes require a pool composition or null.');
  }
  if (!usageLog || typeof usageLog.status !== 'function' || typeof usageLog.append !== 'function') {
    throw new TypeError('Engine routes require a usage log.');
  }
  const limits = resolveLimits(overrides);
  const log = safeLogger(logger);
  const requests = new Set(); // admitted chat requests, at most maxPerMember per member
  let unhook = null;
  const counters = { usage_append_failures: 0 };
  let stopped = false;

  const memberRequests = (memberId) => [...requests].filter((record) => record.memberId === memberId);

  function sendError(response, status, reason) {
    if (response.headersSent || response.destroyed) return;
    const payload = Buffer.from(JSON.stringify(errorPayload(reason)));
    response.writeHead(status, { ...JSON_HEADERS, 'content-length': payload.length, connection: 'close' });
    response.end(payload);
  }

  // A refusal before admission; the body is never read, only drained.
  function refuse(ctx, route, status, reason) {
    const code = reasonOf(reason);
    ctx.request.resume();
    sendError(ctx.response, status, code);
    log('INFO', 'team.engine.refused', { route, status, reason: code });
  }

  function stopTimer(record) {
    if (!record.timer) return;
    clearInterval(record.timer);
    record.timer = null;
  }

  function openStream(record) {
    const { response } = record;
    if (record.sse || response.headersSent || response.destroyed) return;
    // Set, not passed to writeHead: the host's admission reads the content type back with getHeader.
    for (const [name, value] of Object.entries(SSE_HEADERS)) response.setHeader(name, value);
    response.writeHead(200);
    response.flushHeaders();
    record.sse = true;
    record.timer = setInterval(() => {
      if (lostRight(record)) return;
      if (record.relayed === 0) response.write(': keepalive\n\n');
    }, limits.commentIntervalMs);
    record.timer.unref?.();
    record.markReady();
  }

  // R16-F03: the counts are the serving node's word, not a host measurement. Each is clamped to what this
  // request could produce: a token is at least one byte of the request (prompt) or of the relayed reply
  // (completion), and no count passes the leased model's context length when the pool knows it.
  function clampedUsage(record) {
    const usage = readUsage(record.tail);
    const context = record.lease.model_info?.context_length;
    const ceiling = Number.isSafeInteger(context) && context > 0 ? context : Infinity;
    const clamp = (count, bytes) => (count === null ? null : Math.min(count, bytes, ceiling));
    return { prompt: clamp(usage.prompt, record.requestBytes), completion: clamp(usage.completion, record.relayed) };
  }

  function appendUsage(record, outcome, reason) {
    const usage = clampedUsage(record);
    let result;
    try {
      result = usageLog.append({
        member_id: record.memberId, model: record.lease.model, node_id: record.lease.node_id ?? null,
        prompt_tokens: usage.prompt, completion_tokens: usage.completion,
        duration_ms: Math.max(0, clock() - record.started), outcome, reason: outcome === 'completed' ? null : reason,
      });
    } catch (_error) {
      result = null;
    }
    if (result?.ok === true) return;
    counters.usage_append_failures += 1;
    log('WARN', 'team.engine.usage_append_failed', { reason: reasonOf(result?.error?.reason) });
  }

  // Takes an ended request out of `requests` (the member's count and resources()).
  function forget(record) {
    clearTimeout(record.flushTimer);
    record.flushTimer = null;
    requests.delete(record);
  }

  // The record stays in `requests` until its answer has flushed or its socket
  // closed. While bytes wait, each write deadline must see fewer waiting than the
  // last, and the answer may take at most `maxFlushDeadlines` of them; else it is
  // destroyed.
  function holdUntilFlushed(record) {
    const { response } = record;
    if (response.writableFinished || response.destroyed) { forget(record); return; }
    const flushed = () => forget(record);
    response.once('finish', flushed);
    response.once('close', flushed);
    let waiting = response.writableLength;
    let deadlines = 0;
    const check = () => {
      const now = response.writableLength;
      deadlines += 1;
      const ceiling = deadlines >= limits.maxFlushDeadlines;
      if (now >= waiting || ceiling) {
        log('INFO', 'team.engine.unflushed_destroyed', { route: 'chat', pending_bytes: now,
          ...(now < waiting ? { reason: 'ceiling' } : {}) });
        response.destroy();
        forget(record);
        return;
      }
      waiting = now;
      record.flushTimer = setTimeout(check, limits.responseWriteTimeoutMs);
      record.flushTimer.unref?.();
    };
    record.flushTimer = setTimeout(check, limits.responseWriteTimeoutMs);
    record.flushTimer.unref?.();
  }

  // The one end of an admitted request: once only, whatever ended it.
  function settle(record, outcome, reason) {
    if (record.settled) return;
    record.settled = true;
    stopTimer(record);
    try { record.unwatch?.(); } catch (_error) { /* the job is gone */ }
    record.unwatch = null;
    try { record.release?.({ ok: outcome === 'completed' }); } catch (_error) { log('WARN', 'team.engine.release_failed', {}); }
    record.release = null;
    record.body = null;
    holdUntilFlushed(record);
    if (record.lease) appendUsage(record, outcome, reason);
    record.tail = null;
    log('INFO', 'team.engine.request', { route: 'chat', status: record.response.statusCode, stream: record.stream,
      queued: record.queued, outcome, reason, request_bytes: record.requestBytes, response_bytes: record.relayed,
      duration_ms: Math.max(0, clock() - record.started) });
    record.markReady();
  }

  // An end after admission that is not a success: a JSON answer before any head,
  // an error frame on a stream with no data yet, else a cut socket.
  function reject(record, status, reason, outcome = 'failed') {
    const code = reasonOf(reason);
    const { response } = record;
    if (!response.headersSent) sendError(response, status, code);
    else if (record.sse && record.relayed === 0 && !response.destroyed) {
      response.end(`data: ${JSON.stringify(errorPayload(code))}\n\n`);
    } else response.destroy();
    settle(record, outcome, code);
  }

  const rejectFailure = (record, failure) => reject(record,
    statusFor(failure?.error?.reason, failure?.error?.code), failure?.error?.reason);

  // The caller went away, stopped reading or lost the right, or the routes stop:
  // the job and the lease end, nothing is retried. A caller that closed after the node's `[DONE]` has its whole
  // answer: the scheduler completes that job, and the turn is recorded as completed (review H14).
  function abandon(record, reason = 'cancelled') {
    if (record.settled) return;
    record.controller.abort();
    try { record.unwatch?.(); } catch (_error) { /* the job is gone */ }
    record.unwatch = null;
    let answered = false;
    try {
      if (record.job) {
        pool.scheduler.cancelJob(record.job.job_id);
        answered = reason === 'cancelled' && pool.scheduler.getJob(record.job.job_id)?.state === 'done';
      } else if (record.lease && !record.release) pool.scheduler.cancelLease(record.lease.lease_id, { reason: 'cancelled' });
    } catch (_error) {
      log('WARN', 'team.engine.cancel_failed', {});
    }
    // Cut before settling, so the record leaves `requests` now, not on the close event.
    if (!record.response.writableEnded) record.response.destroy();
    if (answered) settle(record, 'completed', null);
    else settle(record, 'cancelled', reasonOf(reason));
  }

  // True when the member has lost the right to use the engine (demoted, revoked, client unbound): the request ends.
  function lostRight(record) {
    if (record.settled) return true;
    const denied = engineDenial(record.ctx);
    if (!denied) return false;
    abandon(record, denied.error.reason);
    return true;
  }

  // The membership recheck: every admitted request asks the one guard again, now.
  function recheck() {
    for (const record of [...requests]) {
      try { lostRight(record); } catch (_error) { log('WARN', 'team.engine.recheck_failed', {}); }
    }
  }

  function onJobEvent(record, event) {
    if (record.settled) return;
    const { response } = record;
    if (event.type === 'data') {
      if (clock() - record.checkedAt >= RECHECK_MS) {
        record.checkedAt = clock();
        if (lostRight(record)) return; // demoted or revoked while the job runs
      }
      stopTimer(record);
      if (!response.headersSent) response.writeHead(200, JSON_HEADERS);
      record.relayed += event.bytes.length;
      keepTail(record, event.bytes);
      if (!response.write(event.bytes) && response.writableLength > limits.maxBufferedBytes) abandon(record, 'client_stalled');
      return;
    }
    if (event.state === 'done') {
      if (!response.headersSent) response.writeHead(200, JSON_HEADERS);
      response.end();
      settle(record, 'completed', null);
      return;
    }
    const reason = reasonOf(event.reason);
    reject(record, TIMEOUT_REASONS.has(reason) ? 504 : 502, reason, event.state === 'cancelled' ? 'cancelled' : 'failed');
  }

  // A parsed body that is a plain object, else null.
  function parsed(bytes) {
    let body;
    try { body = JSON.parse(bytes.toString('utf8')); } catch (_error) { body = null; }
    return isPlainObject(body) ? body : null;
  }

  // The body the node will read, rebuilt from the allowlist; null when it cannot be, with `onRefused(reason)` told why.
  function canonical(raw, onRefused) {
    const checked = raw ? canonicalChatBody(raw) : { ok: false, reason: 'request_body_invalid' };
    if (checked.ok) return checked.body;
    onRefused?.(checked.reason);
    return null;
  }

  // Reads, re-checks and validates the body. Answers `{ body, bytes }` (the parsed
  // body and its raw bytes), or null once the request has ended.
  async function readRequest(record) {
    const { ctx } = record;
    const read = await readBody(ctx.request, limits.maxBodyBytes);
    if (record.settled) return null;
    if (!read.ok) {
      if (read.reason === 'too_large' && !read.closed) { ctx.request.resume(); reject(record, 413, 'job_request_too_large'); } else abandon(record);
      return null;
    }
    const denied = engineDenial(ctx);
    if (denied) { rejectFailure(record, denied); return null; }
    const body = parsed(read.body);
    record.requestBytes = read.body.length;
    if (!body) { reject(record, 400, 'request_body_invalid'); return null; }
    return { body, bytes: read.body };
  }

  // The first parse stays in this frame. A request that queues keeps only its raw
  // bytes on the record across the wait (a body of many small objects parses to
  // many times its size) and parses again once the lease is granted; one granted
  // at once uses the first parse and drops the bytes.
  async function run(record, engineKey) {
    const { ctx } = record;
    const read = (await readRequest(record)) ?? {};
    if (!read.body) return;
    let { bytes = null } = read;
    let body = canonical(read.body, (reason) => reject(record, 400, reason));
    Object.assign(read, { body: null, bytes: null }); // the first parse and the raw bytes live only in the locals
    if (!body) return;
    record.stream = body.stream === true;
    // A model that is not a string names none (the pool's only model), as before.
    const model = typeof body.model === 'string' ? body.model : undefined;
    const wantsVision = hasImagePart(body);
    if (!record.stream) {
      // A non-streamed answer holds a host request slot until it ends: one per member.
      if (memberRequests(record.memberId).some((other) => other.nonStream)) { reject(record, 429, 'engine_member_busy'); return; }
      record.nonStream = true;
    }
    let handle;
    try {
      handle = await pool.engineRoute.acquire({
        memberId: record.memberId, engineKey, model, wantsVision, signal: record.controller.signal,
        onQueued: (lease) => {
          record.lease = lease;
          record.queued = true;
          record.body = bytes;
          body = null;
          if (record.stream) openStream(record);
        },
      });
    } catch (error) {
      if (!record.settled) reject(record, statusFor(error?.reason, error?.code), error?.reason);
      return;
    }
    if (record.settled) { handle.release({ ok: false }); return; }
    record.lease = handle.lease;
    record.release = handle.release;
    const denied = engineDenial(ctx); // revoked or demoted while queued: no job
    if (denied) { rejectFailure(record, denied); return; }
    const info = handle.lease.model_info || { vision: false, thinking: false };
    if (info.vision !== true && wantsVision) { reject(record, 400, 'model_lacks_vision'); return; }
    bytes = null;
    if (!body) body = canonical(parsed(record.body)); // queued: parsed and rebuilt again only now
    record.body = null;
    if (!body) { reject(record, 400, 'request_body_invalid'); return; }
    fitThinking(body, info);
    // R16-F01: the leased model is the body's one model key. The rebuild holds no case variant of `model` (an
    // engine that matches keys without regard to case, as Ollama's Go decoder does, would act on another).
    body.model = handle.lease.model;
    const created = pool.scheduler.createJob(handle.lease.lease_id,
      { requestBytes: Buffer.from(JSON.stringify(body)), stream: record.stream });
    if (!created.ok) { rejectFailure(record, created); return; }
    record.job = created.job;
    record.checkedAt = clock();
    record.unwatch = pool.scheduler.watchJob(created.job.job_id, (event) => onJobEvent(record, event));
    if (!record.unwatch) {
      pool.scheduler.cancelJob(created.job.job_id);
      reject(record, 503, 'team_pool_unavailable');
      return;
    }
    if (record.stream) openStream(record);
  }

  // Returns once the event-stream head is out or the answer is complete, so a
  // streamed answer holds no host request slot while it queues and streams.
  async function serveChat(ctx, memberId, engineKey) {
    let store;
    try { store = usageLog.status(); } catch (_error) { store = hostFailure('persistence', 'pool_usage_store_failed'); }
    if (!store.ok) { refuse(ctx, 'chat', 503, store.error?.reason); return; }
    if (memberRequests(memberId).length >= limits.maxPerMember) { refuse(ctx, 'chat', 429, 'engine_member_busy'); return; }
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const record = { ctx, response: ctx.response, memberId, started: clock(), controller: new AbortController(),
      lease: null, release: null, job: null, unwatch: null, timer: null, tail: Buffer.alloc(0), markReady,
      stream: false, nonStream: false, sse: false, queued: false, relayed: 0, requestBytes: 0, checkedAt: 0,
      settled: false, body: null, flushTimer: null };
    requests.add(record);
    ctx.response.on('close', () => abandon(record));
    run(record, engineKey).catch(() => {
      log('WARN', 'team.engine.failed', {});
      abandon(record);
    });
    await ready;
  }

  // A pool that tells when membership was rechecked (its `recheckLeases` runs after a revocation or a role change).
  if (pool !== null && typeof pool.onRecheck === 'function') unhook = pool.onRecheck(recheck);

  function serveModels(ctx) {
    ctx.request.resume();
    const models = pool.scheduler.poolSummary().models;
    const payload = Buffer.from(JSON.stringify({
      // `context_length` (the per-model smallest) only for a model whose length the pool knows (slice 4f); `vision` /
      // `thinking` only when a serving node has them (the member's team-engine.js reads only true ones).
      object: 'list', data: models.map((entry) => ({ id: entry.id, object: 'model', created: 0, owned_by: 'team',
        ...(Number.isSafeInteger(entry.context_length) ? { context_length: entry.context_length } : {}),
        ...(entry.vision === true ? { vision: true } : {}), ...(entry.thinking === true ? { thinking: true } : {}) })),
    }));
    ctx.response.writeHead(200, { ...JSON_HEADERS, 'content-length': payload.length });
    ctx.response.end(payload);
    log('INFO', 'team.engine.request', { route: 'models', status: 200, models: models.length });
  }

  async function handle(ctx = {}) {
    const route = `${String(ctx.request?.method || '').toUpperCase()} ${String(ctx.pathname || '')}`;
    if (route !== CHAT_ROUTE && route !== MODELS_ROUTE) return false;
    const label = route === CHAT_ROUTE ? 'chat' : 'models';
    try {
      const denied = engineDenial(ctx);
      if (denied) { refuse(ctx, label, statusFor(denied.error.reason, denied.error.code), denied.error.reason); return true; }
      const engineKey = ctx.request.headers[ENGINE_KEY_HEADER];
      if (engineKey !== undefined && !(typeof engineKey === 'string' && ENGINE_KEY_PATTERN.test(engineKey))) {
        refuse(ctx, label, 400, 'engine_key_invalid');
        return true;
      }
      if (stopped || pool === null) { refuse(ctx, label, 503, 'team_pool_unavailable'); return true; }
      if (label === 'models') serveModels(ctx);
      else await serveChat(ctx, ctx.actor.member_id, engineKey);
    } catch (_error) {
      log('WARN', 'team.engine.failed', {});
      if (!ctx.response?.headersSent) ctx.response?.destroy();
    }
    return true;
  }

  // Every in-flight request is cancelled, its lease released once, its timer cleared;
  // an ended answer still flushing is cut.
  async function stop() {
    stopped = true;
    try { unhook?.(); } catch (_error) { /* the pool is gone */ }
    unhook = null;
    for (const record of [...requests]) {
      if (!record.settled) { abandon(record); continue; }
      record.response.destroy();
      forget(record);
    }
  }

  // `body_bytes`: raw request bytes held while a lease is awaited.
  function resources() {
    const held = [...requests];
    return { requests: held.length,
      timers: held.filter((record) => record.timer !== null).length
        + held.filter((record) => record.flushTimer !== null).length,
      leases: held.filter((record) => record.release !== null).length,
      body_bytes: held.reduce((sum, record) => sum + (record.body ? record.body.length : 0), 0) };
  }

  return Object.assign(handle, { stop, recheck, resources, counters: () => ({ ...counters }) });
}

module.exports = { ENGINE_ACTION, TEAM_RESOURCE, createEngineRoutes, memberRouteDenial };
