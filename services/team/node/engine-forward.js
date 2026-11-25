'use strict';

// One team job against this PC's own engine (row 123 slice 4c agent; spec "Node side
// (N9)" and "4c agent as built"). The engine is reached only at a loopback origin the
// member's own Jenny names (`checkEngineUrl`), only at `/v1/models` and
// `/v1/chat/completions`, with the agent's own two headers and no redirect followed.
// A job reads its request once, forwards it unchanged, and relays the answer to the
// host as bounded chunks with rising sequence numbers, one POST at a time and at most
// eight a second. It runs no tool, keeps no prompt or reply after it ends, and is
// never sent again: every way out but a clean end or a host cancel sends one `fail`
// with the scheduler's word. Log lines carry the job id, byte counts, durations and
// reason words only.

const http = require('node:http');
const { MAX_STREAM_REQUEST_BYTES: MAX_REQUEST_BYTES } = require('../http-client'); // the host's limits.maxRequestBytes
const { JOB_ID } = require('./node-link');
const { isCloudModelName } = require('../../cli-host/local-only-providers');
const { isCanonicalBody } = require('../../../server/team/engine-request-fields');

const MAX_CHUNK_BYTES = 64 * 1024; // the host's limits.maxChunkBytes
// One chunk POST starts at most every 125 ms: 8 a second, 480 a minute for a job, so a
// slot (one job at a time) stays under the host's 600 chunk POSTs a minute a slot with
// room for a heartbeat ping (at most 6 a minute at the host's 10 s heartbeat).
const FLUSH_INTERVAL_MS = 125;
const HIGH_WATER_BYTES = 4 * MAX_CHUNK_BYTES; // the engine is paused while this much waits
const CHAT_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';
const MODELS_MAX_BYTES = 1024 * 1024;
const MODELS_TIMEOUT_MS = 5_000;
const MAX_MODELS = 64; // the host's register schema
const MODEL_NAME = /^[\x21-\x7e][\x20-\x7e]{0,127}$/u;
const isModelName = (value) => typeof value === 'string' && MODEL_NAME.test(value);
const TEAM_CALL_TIMEOUT_MS = 15_000;
const TEAM_RETRIES = 3; // a lost chunk or request answer is asked again this often, with backoff
const RETRY_BASE_MS = 500;
const CHUNK_RATE_WAIT_MS = 2_000; // node_rate_limit on a request read or a chunk
const MAX_TIMEOUT_MS = 2 * 60 * 60_000;
// The engine URL as the member's Jenny names it, by its text: no other host, scheme,
// user, query or path. `localhost` is sent to 127.0.0.1, never to the system resolver.
const LOCAL_ENGINE = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):(\d{1,5})(\/v1)?\/?$/u;
// Refusals that end sharing: the member may no longer share.
const FINAL_REASONS = Object.freeze(new Set(['member_revoked', 'role_forbidden', 'member_pending',
  'team_connection_stopped']));
// A reason word from the host is used only when it is a word; anything else is `fallback`.
const REASON_WORD = /^[a-z][a-z0-9_]{0,63}$/u;
function reasonWord(answer, fallback) {
  const word = answer?.error?.reason;
  return typeof word === 'string' && REASON_WORD.test(word) ? word : fallback;
}

// A job's own states. Every other move is refused and changes nothing.
const JOB_TRANSITIONS = Object.freeze({
  fetching: Object.freeze(['forwarding', 'failed', 'cancelled', 'stopped']),
  forwarding: Object.freeze(['done', 'failed', 'cancelled', 'stopped']),
});
const nextJobState = (from, to) => (JOB_TRANSITIONS[from]?.includes(to) ? to : null);

function checkEngineUrl(text) {
  const match = typeof text === 'string' ? LOCAL_ENGINE.exec(text) : null;
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65535) return { ok: false, reason: 'node_engine_not_local' };
  return { ok: true, host: { '[::1]': '::1', localhost: '127.0.0.1' }[match[1]] ?? match[1], port };
}

// The engine side: one request per call, no pooled socket, no redirect followed (a 3xx is
// an answer like any other). `openRequests()` counts requests whose socket is still open.
function createEngineClient({ request = http.request } = {}) {
  let open = 0;
  function call({ target, method, path, body = null, signal = null }) {
    return new Promise((resolve, reject) => {
      const headers = body
        ? { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', 'Content-Length': body.length }
        : { Accept: 'application/json' };
      let req;
      try {
        req = request({ host: target.host, port: target.port, method, path, headers, agent: false, signal });
      } catch (_error) {
        reject(new Error('engine_unreachable'));
        return;
      }
      open += 1;
      req.once('close', () => { open -= 1; });
      req.on('error', () => reject(new Error('engine_unreachable')));
      req.on('response', (response) => {
        response.on('error', () => {});
        resolve({ status: response.statusCode, body: response });
      });
      req.end(body || undefined);
    });
  }
  return { call, openRequests: () => open };
}

// Reads a stream to its end, or null past `max` bytes or on an error.
function readBounded(stream, max) {
  return new Promise((resolve) => {
    const parts = [];
    let size = 0;
    let done = false;
    const end = (value) => { if (!done) { done = true; resolve(value); } };
    stream.on('data', (part) => {
      size += part.length;
      if (size > max) { stream.destroy(); end(null); return; }
      parts.push(part);
    });
    stream.on('end', () => end(Buffer.concat(parts)));
    stream.on('error', () => end(null));
    stream.on('close', () => end(null));
  });
}

const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
// Where an engine's `/v1/models` row says its context length (the OpenAI-style field, llama-server's `meta`,
// vLLM's `max_model_len`, and the usual spellings), first match wins.
const CONTEXT_FIELDS = Object.freeze([(row) => row.context_length, (row) => row.meta?.n_ctx, (row) => row.max_model_len,
  (row) => row.context_window, (row) => row.max_context_length]);

// The engine's models as the host's register takes them: printable names of at most 128
// characters, no duplicate, at most 64; the context length when the engine says it. An Ollama
// cloud model (`-cloud` or `:cloud`, the CLI's local-only rule) is never offered, on any engine.
// A request that names one is refused before it reaches the engine (run() below).
async function readModels({ engine, target, timers, signal = null, timeoutMs = MODELS_TIMEOUT_MS }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timers.setTimeout(onAbort, timeoutMs);
  try {
    if (signal?.aborted) return { ok: false, reason: 'node_agent_stopped' };
    let answer;
    try {
      answer = await engine.call({ target, method: 'GET', path: MODELS_PATH, signal: controller.signal });
    } catch (_error) {
      return { ok: false, reason: 'engine_unreachable' };
    }
    if (answer.status !== 200) { answer.body.destroy(); return { ok: false, reason: 'engine_error' }; }
    const bytes = await readBounded(answer.body, MODELS_MAX_BYTES);
    let parsed = null;
    try { parsed = bytes ? JSON.parse(bytes.toString('utf8')) : null; } catch (_error) { parsed = null; }
    if (!parsed || !Array.isArray(parsed.data)) return { ok: false, reason: 'engine_error' };
    const seen = new Set();
    const models = [];
    for (const entry of parsed.data) {
      const name = entry && typeof entry.id === 'string' ? entry.id : '';
      if (!MODEL_NAME.test(name) || isCloudModelName(name) || seen.has(name) || models.length >= MAX_MODELS) continue;
      seen.add(name);
      const contextLength = CONTEXT_FIELDS.map((read) => positiveInt(read(entry))).find((value) => value !== null) ?? null;
      models.push({ name, context_length: contextLength, vision: false, thinking: false });
    }
    return { ok: true, models };
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Where the JSON string opening at `start` closes: the next quote not escaped by an odd run of backslashes.
function stringEnd(text, start) {
  for (let end = text.indexOf('"', start + 1); ; end = text.indexOf('"', end + 1)) {
    let slashes = 0;
    while (text[end - 1 - slashes] === '\\') slashes += 1;
    if (slashes % 2 === 0) return end;
  }
}

// The top-level keys of an object text JSON.parse accepted, in order and with every duplicate (JSON.parse
// keeps only the last), each decoded as JSON decodes it (a key with a unicode escape for its `M` is `Model`).
function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (depth === 1 && expectKey) keys.push(JSON.parse(text.slice(i, end + 1)));
      expectKey = false;
      i = end;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      expectKey = depth === 1;
    } else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 1) expectKey = true;
  }
  return keys;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// R16-F01: true only when the request names `model` and nothing else as its model: strict UTF-8, one JSON
// object, exactly one top-level key that folds to `model`, spelt `model`, equal to the descriptor's model,
// which is not an Ollama cloud model. An engine may match keys without regard to case (Ollama's Go decoder
// takes `Model` for `model`, the later key winning), so a case variant or a duplicate is refused, never
// cleaned. The bytes checked here are the bytes forwarded.
function namesOnlyModel(request, model) {
  if (!isModelName(model) || isCloudModelName(model)) return false;
  let text;
  let parsed;
  try {
    text = STRICT_UTF8.decode(request);
    parsed = JSON.parse(text);
  } catch (_error) {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const named = topLevelKeys(text).filter((key) => key.toLowerCase() === 'model');
  return named.length === 1 && named[0] === 'model' && parsed.model === model;
}

// C5, the node's own check: the host forwards only the canonical body (server/team/engine-request-fields.js), so a
// request with a key the host would have dropped, or a case variant anywhere it checks, is not run on this PC.
function canonicalOnly(request) {
  let parsed;
  try { parsed = JSON.parse(STRICT_UTF8.decode(request)); } catch (_error) { return false; }
  return isCanonicalBody(parsed);
}

// The descriptor's bounds, or null when it is not one the agent can run.
function jobLimits(descriptor) {
  const bounded = (value) => (Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS ? value : null);
  if (!descriptor || typeof descriptor !== 'object' || !JOB_ID.test(String(descriptor.job_id))) return null;
  const limits = { requestBytes: descriptor.request_bytes, firstByteMs: bounded(descriptor.first_byte_ms),
    stallMs: bounded(descriptor.stall_ms), totalMs: bounded(descriptor.total_ms) };
  if (!Number.isSafeInteger(limits.requestBytes) || limits.requestBytes < 1 || limits.requestBytes > MAX_REQUEST_BYTES) return null;
  return limits.firstByteMs && limits.stallMs && limits.totalMs ? limits : null;
}

// Runs one claimed job. Answers { jobId, stop({ quiet }), abortFail(), done }:
// `done` resolves { state, reason } once the job has ended and its `fail` (if any) was
// answered or cut off. `stop` ends it with user_stopped_sharing (`quiet`: send nothing).
function startJob({ descriptor, limits, link, engine, target, timers, clock, heartbeatMs, log, onRequestRead, onFinal }) {
  const jobId = descriptor.job_id;
  const startedAt = clock();
  const engineAbort = new AbortController();
  const teamAbort = new AbortController();
  const failAbort = new AbortController();
  const live = new Set();
  let state = 'fetching';
  let ended = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  let body = null;
  let queue = [];
  let queued = 0;
  let engineEnded = false;
  let sawByte = false;
  let sending = false;
  let seq = 0;
  let lastPostAt = -Infinity;
  let bytesIn = 0;
  let bytesOut = 0;
  const slots = { first: null, stall: null, total: null, flush: null, ping: null };

  function later(fn, ms) {
    const handle = timers.setTimeout(() => { live.delete(handle); fn(); }, ms);
    live.add(handle);
    return handle;
  }
  function cancel(name) { if (slots[name]) { timers.clearTimeout(slots[name]); live.delete(slots[name]); slots[name] = null; } }
  const pause = (ms) => new Promise((resolve) => { later(resolve, ms); });

  function sendFail(word) {
    return link.command('team.node.fail', { job_id: jobId, reason: word }, { timeoutMs: TEAM_CALL_TIMEOUT_MS,
      signal: failAbort.signal }).then(() => {}, () => {});
  }

  // The one way a job ends: the engine request is cut, every timer and byte dropped.
  function finish(to, reason, failWord = null) {
    if (ended || !nextJobState(state, to)) return done;
    ended = true;
    state = to;
    engineAbort.abort();
    teamAbort.abort();
    if (body) body.destroy();
    for (const handle of live) timers.clearTimeout(handle);
    live.clear();
    queue = [];
    queued = 0;
    log('INFO', 'team.node.job_ended', { job_id: jobId, state: to, reason, bytes_in: bytesIn, bytes_out: bytesOut,
      ms: Math.max(0, Math.round(clock() - startedAt)) });
    const sent = failWord && !failAbort.signal.aborted ? sendFail(failWord) : Promise.resolve();
    sent.then(() => settle({ state: to, reason }));
    return done;
  }
  const failWith = (word, reason = word) => finish('failed', reason, word);

  // A team refusal that is not about this job.
  function refused(answer) {
    const word = reasonWord(answer, 'team_refused');
    if (word === 'job_not_found') { finish('cancelled', word); return; }
    if (FINAL_REASONS.has(word)) { finish('stopped', word); onFinal(word); return; }
    failWith('engine_error', word);
  }

  async function readRequest() {
    for (let attempt = 0; attempt <= TEAM_RETRIES; attempt += 1) {
      onRequestRead();
      let answer;
      try {
        answer = await link.fetchRequest(jobId, { maxBytes: limits.requestBytes, timeoutMs: TEAM_CALL_TIMEOUT_MS,
          signal: teamAbort.signal });
      } catch (_error) {
        if (ended) return null;
        await pause(RETRY_BASE_MS * 2 ** attempt);
        if (ended) return null;
        continue;
      }
      if (ended) return null;
      if (answer?.ok === true && Buffer.isBuffer(answer.bytes) && answer.bytes.length <= limits.requestBytes) return answer.bytes;
      if (answer?.ok === true) { failWith('engine_error', 'job_request_too_large'); return null; }
      if (reasonWord(answer, '') === 'node_rate_limit' && attempt < TEAM_RETRIES) {
        await pause(CHUNK_RATE_WAIT_MS);
        if (ended) return null;
        continue;
      }
      refused(answer);
      return null;
    }
    failWith('engine_error', 'team_unreachable');
    return null;
  }

  function armPing() {
    cancel('ping');
    slots.ping = later(() => { slots.ping = null; if (!sending) send(Buffer.alloc(0), false); }, heartbeatMs);
  }
  function armStall() {
    cancel('stall');
    slots.stall = later(() => failWith('engine_timeout', 'stall_timeout'), limits.stallMs);
  }

  function take(max) {
    const out = [];
    let size = 0;
    while (queue.length > 0 && size < max) {
      const head = queue[0];
      const room = max - size;
      if (head.length <= room) { out.push(queue.shift()); size += head.length; } else { out.push(head.subarray(0, room)); queue[0] = head.subarray(room); size += room; }
    }
    queued -= size;
    return Buffer.concat(out, size);
  }

  // Sends what waits, never two POSTs at once and never sooner than FLUSH_INTERVAL_MS apart.
  function pump() {
    if (ended || sending || (queued === 0 && !engineEnded)) return;
    const wait = lastPostAt + FLUSH_INTERVAL_MS - clock();
    if (wait > 0) {
      if (!slots.flush) slots.flush = later(() => { slots.flush = null; pump(); }, wait);
      return;
    }
    const piece = take(MAX_CHUNK_BYTES);
    send(piece, engineEnded && queued === 0);
  }

  // `post` is async: anything it throws ends the job once instead of going unhandled.
  function send(bytes, final) {
    post(bytes, final).catch(() => {
      log('WARN', 'team.node.job_post_error', { job_id: jobId });
      failWith('engine_error', 'node_post_error');
    });
  }

  async function post(bytes, final) {
    sending = true;
    cancel('ping');
    if (bytes.length > 0) lastPostAt = clock(); // a ping never holds back the next chunk
    let answer;
    let retried = false; // an earlier try of this chunk may have landed with its answer lost
    for (let attempt = 0, waits = 0; ;) {
      try {
        answer = await link.postChunk(jobId, { seq, final, bytes, timeoutMs: TEAM_CALL_TIMEOUT_MS, signal: teamAbort.signal });
      } catch (_error) {
        if (ended) return;
        if (attempt >= TEAM_RETRIES) { failWith('engine_error', 'team_unreachable'); return; }
        await pause(RETRY_BASE_MS * 2 ** attempt);
        attempt += 1;
        retried = true;
        if (ended) return;
        continue;
      }
      if (ended) return;
      if (answer?.ok !== true && reasonWord(answer, '') === 'node_rate_limit' && waits < TEAM_RETRIES) {
        await pause(CHUNK_RATE_WAIT_MS);
        waits += 1;
        if (ended) return;
        continue;
      }
      break;
    }
    sending = false;
    // A retried chunk the host already holds is answered node_chunk_seq_invalid with the number after it (C7): taken.
    const held = retried && reasonWord(answer, '') === 'node_chunk_seq_invalid' && answer.next_seq === seq + 1;
    if (answer?.ok !== true && !held) { refused(answer); return; }
    bytesOut += bytes.length;
    seq = Number.isSafeInteger(answer.next_seq) && answer.next_seq > seq ? answer.next_seq : seq + 1;
    if (answer.cancel === true) { finish('cancelled', 'cancelled'); return; }
    if (final) { finish('done', 'done'); return; }
    // The stall timer runs only while the engine may send: it is off while the agent holds it.
    if (body && body.isPaused() && queued < HIGH_WATER_BYTES / 2) { body.resume(); armStall(); }
    armPing();
    pump();
  }

  function onData(part) {
    if (ended) return;
    if (!sawByte) { sawByte = true; cancel('first'); }
    armStall();
    bytesIn += part.length;
    queue.push(part);
    queued += part.length;
    if (queued >= HIGH_WATER_BYTES) { body.pause(); cancel('stall'); }
    pump();
  }

  async function run() {
    slots.total = later(() => failWith('engine_timeout', 'job_timeout'), limits.totalMs);
    armPing();
    const request = await readRequest();
    if (!request || ended) return;
    if (!namesOnlyModel(request, descriptor.model)) { failWith('model_not_loaded', 'model_not_local'); return; }
    if (!canonicalOnly(request)) { failWith('engine_error', 'team_request_field_invalid'); return; }
    state = nextJobState(state, 'forwarding');
    slots.first = later(() => failWith('engine_timeout', 'first_byte_timeout'), limits.firstByteMs);
    let answer;
    try {
      answer = await engine.call({ target, method: 'POST', path: CHAT_PATH, body: request, signal: engineAbort.signal });
    } catch (_error) {
      if (!ended) failWith('engine_unreachable');
      return;
    }
    if (ended) { answer.body.destroy(); return; }
    if (answer.status !== 200) {
      answer.body.destroy();
      failWith(answer.status === 404 ? 'model_not_loaded' : 'engine_error', `engine_status_${answer.status}`);
      return;
    }
    body = answer.body;
    body.on('data', onData);
    body.on('end', () => { if (ended) return; engineEnded = true; cancel('stall'); pump(); });
    body.on('close', () => { if (!engineEnded && !ended) failWith('engine_error', 'engine_closed'); });
  }

  run().catch(() => { if (!ended) failWith('engine_error', 'node_job_error'); });

  return {
    jobId,
    done,
    stop({ quiet = false } = {}) {
      if (quiet) failAbort.abort();
      return finish('stopped', 'user_stopped_sharing', quiet ? null : 'user_stopped_sharing');
    },
    abortFail() { failAbort.abort(); },
  };
}

module.exports = {
  FINAL_REASONS, JOB_TRANSITIONS, checkEngineUrl, createEngineClient, isModelName, jobLimits, nextJobState, readBounded, readModels,
  reasonWord, startJob,
};
